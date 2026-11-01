// Document Tracker (DMTS) - portable offline app.
// The Rust side owns the SQLite database and the file vault (both in a
// "DMTSData" folder next to the .exe) and provides helpers: importing files
// (SHA-256, de-duplicated), opening/saving copies, Excel export and backup.
// All screens live in ../ui.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use rust_xlsxwriter::{Color, Format, Workbook};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

struct AppState {
    conn: Mutex<Connection>,
    data_dir: PathBuf,
}

/// Prefer a folder next to the .exe (portable). If that folder is not
/// writable (e.g. the exe was copied into Program Files), fall back to AppData.
fn pick_data_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("DMTSData");
            if std::fs::create_dir_all(&candidate).is_ok() {
                let probe = candidate.join(".write_test");
                if std::fs::write(&probe, b"ok").is_ok() {
                    let _ = std::fs::remove_file(&probe);
                    return candidate;
                }
            }
        }
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let fallback = base.join("DocumentTracker");
    let _ = std::fs::create_dir_all(&fallback);
    fallback
}

fn to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(if *b { 1 } else { 0 }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                SqlValue::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
fn db_query(
    state: State<'_, AppState>,
    sql: String,
    params: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, String> {
    let conn = state.conn.lock().map_err(err)?;
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let cols: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(String::from)
        .collect();
    let p: Vec<SqlValue> = params.iter().map(to_sql).collect();
    let mut rows = stmt.query(params_from_iter(p.iter())).map_err(err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        let mut m = Map::new();
        for (i, c) in cols.iter().enumerate() {
            let v = match row.get_ref(i).map_err(err)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(f) => json!(f),
                ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
                ValueRef::Blob(_) => Value::Null,
            };
            m.insert(c.clone(), v);
        }
        out.push(m);
    }
    Ok(out)
}

#[tauri::command]
fn db_execute(
    state: State<'_, AppState>,
    sql: String,
    params: Vec<Value>,
) -> Result<Value, String> {
    let conn = state.conn.lock().map_err(err)?;
    let p: Vec<SqlValue> = params.iter().map(to_sql).collect();
    let changes = conn.execute(&sql, params_from_iter(p.iter())).map_err(err)?;
    Ok(json!({ "changes": changes, "lastId": conn.last_insert_rowid() }))
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> Value {
    json!({
        "dataDir": state.data_dir.to_string_lossy(),
        "dbPath": state.data_dir.join("dmts.db").to_string_lossy(),
        "version": env!("CARGO_PKG_VERSION"),
    })
}

/// Turns a stored relative path like "vault/ab/<hash>.pdf" into a full path,
/// refusing anything that could escape the data folder.
fn resolve_rel(state: &AppState, rel: &str) -> Result<PathBuf, String> {
    let parts: Vec<&str> = rel.split('/').collect();
    let ok = parts.len() == 3
        && parts[0] == "vault"
        && parts.iter().all(|p| {
            !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        })
        && !rel.contains("..");
    if !ok {
        return Err("Invalid file reference".into());
    }
    Ok(state.data_dir.join(parts[0]).join(parts[1]).join(parts[2]))
}

/// Opens the Windows "choose files" window (PDF first).
#[tauri::command]
async fn pick_files() -> Vec<String> {
    rfd::FileDialog::new()
        .add_filter("PDF files", &["pdf"])
        .add_filter("All files", &["*"])
        .pick_files()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// Copies a file into the vault, named by its SHA-256 (identical files are stored once).
/// The original file is never moved or changed.
#[tauri::command]
async fn vault_import(state: State<'_, AppState>, src: String) -> Result<Value, String> {
    let src_path = PathBuf::from(&src);
    let mut f = std::fs::File::open(&src_path).map_err(|e| format!("Cannot open {}: {}", src, e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut size: u64 = 0;
    loop {
        let n = f.read(&mut buf).map_err(err)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    let hash = format!("{:x}", hasher.finalize());
    let ext: String = src_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    let ext = if ext.is_empty() { "bin".to_string() } else { ext };
    let file = format!("{}.{}", hash, ext);
    let dir = state.data_dir.join("vault").join(&hash[..2]);
    std::fs::create_dir_all(&dir).map_err(err)?;
    let dest = dir.join(&file);
    if !dest.exists() {
        let tmp = dir.join(format!("{}.part", hash));
        std::fs::copy(&src_path, &tmp).map_err(err)?;
        std::fs::rename(&tmp, &dest).map_err(err)?;
    }
    let name = src_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| file.clone());
    Ok(json!({
        "sha256": hash,
        "size": size,
        "relPath": format!("vault/{}/{}", &hash[..2], file),
        "fileName": name,
    }))
}

/// Opens a stored file in its default program (PDF viewer).
#[tauri::command]
fn open_file(state: State<'_, AppState>, rel: String) -> Result<(), String> {
    let p = resolve_rel(&state, &rel)?;
    if !p.exists() {
        return Err("The file is missing from the vault folder".into());
    }
    open::that(&p).map_err(err)
}

/// "Download": asks where to save, then copies the stored file there with its original name.
#[tauri::command]
async fn save_copy(state: State<'_, AppState>, rel: String, name: String) -> Result<Option<String>, String> {
    let p = resolve_rel(&state, &rel)?;
    let dest = match rfd::FileDialog::new().set_file_name(&name).save_file() {
        Some(d) => d,
        None => return Ok(None),
    };
    std::fs::copy(&p, &dest).map_err(err)?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

/// Backup into a folder the user picks (e.g. their Google Drive / OneDrive folder):
/// a dated copy of the database + any vault files not yet copied there.
#[tauri::command]
async fn backup_to_folder(state: State<'_, AppState>, db_name: String) -> Result<Option<Value>, String> {
    let folder = match rfd::FileDialog::new().set_title("Choose backup folder").pick_folder() {
        Some(f) => f,
        None => return Ok(None),
    };
    let safe: String = db_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    if safe.is_empty() {
        return Err("Invalid backup name".into());
    }
    let target = folder.join("DocumentTracker-Backup");
    std::fs::create_dir_all(target.join("database")).map_err(err)?;
    let db_dest = target.join("database").join(&safe);
    let db_dest_str = db_dest.to_string_lossy().into_owned();
    {
        let conn = state.conn.lock().map_err(err)?;
        conn.execute("VACUUM INTO ?1", [&db_dest_str]).map_err(err)?;
    }
    let mut copied = 0u32;
    let vault = state.data_dir.join("vault");
    if let Ok(subdirs) = std::fs::read_dir(&vault) {
        for sub in subdirs.flatten() {
            if !sub.path().is_dir() {
                continue;
            }
            let out_dir = target.join("vault").join(sub.file_name());
            std::fs::create_dir_all(&out_dir).map_err(err)?;
            if let Ok(files) = std::fs::read_dir(sub.path()) {
                for f in files.flatten() {
                    let name = f.file_name();
                    if name.to_string_lossy().ends_with(".part") {
                        continue;
                    }
                    let out = out_dir.join(&name);
                    if !out.exists() {
                        std::fs::copy(f.path(), &out).map_err(err)?;
                        copied += 1;
                    }
                }
            }
        }
    }
    Ok(Some(json!({ "path": target.to_string_lossy(), "copied": copied })))
}

#[tauri::command]
fn open_data_folder(state: State<'_, AppState>) -> Result<(), String> {
    open::that(&state.data_dir).map_err(err)
}

/// Asks where to save, then writes a simple one-sheet Excel file.
#[tauri::command]
async fn export_xlsx(
    default_name: String,
    sheet_name: String,
    headers: Vec<String>,
    rows: Vec<Vec<Value>>,
) -> Result<Option<String>, String> {
    let path = match rfd::FileDialog::new()
        .set_file_name(&default_name)
        .add_filter("Excel Workbook", &["xlsx"])
        .save_file()
    {
        Some(p) => p,
        None => return Ok(None),
    };

    let mut wb = Workbook::new();
    let header_fmt = Format::new().set_bold().set_background_color(Color::RGB(0xDCE6F1));
    let ws = wb.add_worksheet();
    let safe: String = sheet_name
        .chars()
        .filter(|c| !"[]:*?/\\".contains(*c))
        .take(31)
        .collect();
    if !safe.is_empty() {
        ws.set_name(&safe).map_err(err)?;
    }
    for (c, h) in headers.iter().enumerate() {
        ws.write_string_with_format(0, c as u16, h, &header_fmt)
            .map_err(err)?;
    }
    for (r, row) in rows.iter().enumerate() {
        let rr = (r + 1) as u32;
        for (c, v) in row.iter().enumerate() {
            let cc = c as u16;
            match v {
                Value::Null => {}
                Value::Number(n) => {
                    ws.write_number(rr, cc, n.as_f64().unwrap_or(0.0)).map_err(err)?;
                }
                Value::Bool(b) => {
                    ws.write_boolean(rr, cc, *b).map_err(err)?;
                }
                Value::String(s) => {
                    ws.write_string(rr, cc, s).map_err(err)?;
                }
                other => {
                    ws.write_string(rr, cc, other.to_string()).map_err(err)?;
                }
            }
        }
    }
    ws.autofit();
    wb.save(&path).map_err(err)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn fatal(msg: &str) -> ! {
    rfd::MessageDialog::new()
        .set_title("Document Tracker")
        .set_description(msg)
        .set_level(rfd::MessageLevel::Error)
        .show();
    std::process::exit(1);
}

fn main() {
    let data_dir = pick_data_dir();
    let db_path = data_dir.join("dmts.db");
    let conn = match Connection::open(&db_path) {
        Ok(c) => c,
        Err(e) => fatal(&format!("Could not open the database at {}:\n{}", db_path.display(), e)),
    };
    if let Err(e) = conn.execute_batch(include_str!("schema.sql")) {
        fatal(&format!("Could not prepare the database:\n{}", e));
    }

    tauri::Builder::default()
        .manage(AppState {
            conn: Mutex::new(conn),
            data_dir,
        })
        .invoke_handler(tauri::generate_handler![
            db_query,
            db_execute,
            app_info,
            pick_files,
            vault_import,
            open_file,
            save_copy,
            backup_to_folder,
            open_data_folder,
            export_xlsx
        ])
        .run(tauri::generate_context!())
        .expect("error while running Document Tracker");
}
