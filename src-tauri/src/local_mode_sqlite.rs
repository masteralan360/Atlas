use std::collections::HashMap;

use serde_json::{Map, Number, Value};
use sqlx::{
    sqlite::{Sqlite, SqliteValueRef},
    Column, Row, TypeInfo, Value as SqlxValue, ValueRef,
};
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct LocalModeSqliteTransactionState {
    transactions: Mutex<HashMap<String, sqlx::Transaction<'static, Sqlite>>>,
}

#[tauri::command]
pub async fn begin_local_mode_sqlite_transaction(
    db_instances: State<'_, DbInstances>,
    state: State<'_, LocalModeSqliteTransactionState>,
    db: String,
    transaction_id: String,
) -> Result<(), String> {
    let instances = db_instances.0.read().await;
    let pool = instances
        .get(&db)
        .ok_or_else(|| format!("SQLite database is not loaded: {db}"))?;
    let DbPool::Sqlite(pool) = pool;
    let transaction = pool.begin().await.map_err(|error| error.to_string())?;
    drop(instances);

    let previous = state
        .transactions
        .lock()
        .await
        .insert(transaction_id, transaction);
    if previous.is_some() {
        return Err("A SQLite transaction with this ID is already active.".into());
    }
    Ok(())
}

fn bind_values<'q>(
    mut query: sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    values: Vec<Value>,
) -> sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    for value in values {
        query = if value.is_null() {
            query.bind(None::<Value>)
        } else if let Some(text) = value.as_str() {
            query.bind(text.to_owned())
        } else if let Some(number) = value.as_number() {
            query.bind(number.as_f64().unwrap_or_default())
        } else {
            query.bind(value)
        };
    }
    query
}

#[tauri::command]
pub async fn execute_local_mode_sqlite_transaction(
    state: State<'_, LocalModeSqliteTransactionState>,
    transaction_id: String,
    query: String,
    values: Vec<Value>,
) -> Result<Value, String> {
    let mut transactions = state.transactions.lock().await;
    let transaction = transactions
        .get_mut(&transaction_id)
        .ok_or_else(|| "The SQLite transaction is no longer active.".to_string())?;
    let result = bind_values(sqlx::query(&query), values)
        .execute(&mut **transaction)
        .await
        .map_err(|error| error.to_string())?;

    Ok(serde_json::json!({
        "rowsAffected": result.rows_affected(),
        "lastInsertId": result.last_insert_rowid(),
    }))
}

fn sqlite_value_to_json(value: SqliteValueRef<'_>) -> Result<Value, String> {
    if value.is_null() {
        return Ok(Value::Null);
    }

    let type_info = value.type_info();
    let type_name = type_info.name();
    match type_name {
        "TEXT" => Ok(value
            .to_owned()
            .try_decode::<String>()
            .map(Value::String)
            .unwrap_or(Value::Null)),
        "REAL" => Ok(value
            .to_owned()
            .try_decode::<f64>()
            .ok()
            .and_then(Number::from_f64)
            .map(Value::Number)
            .unwrap_or(Value::Null)),
        "INTEGER" | "NUMERIC" => Ok(value
            .to_owned()
            .try_decode::<i64>()
            .map(Number::from)
            .map(Value::Number)
            .unwrap_or(Value::Null)),
        "BOOLEAN" => Ok(value
            .to_owned()
            .try_decode::<bool>()
            .map(Value::Bool)
            .unwrap_or(Value::Null)),
        "DATE" | "TIME" | "DATETIME" => Ok(value
            .to_owned()
            .try_decode::<String>()
            .map(Value::String)
            .unwrap_or(Value::Null)),
        "BLOB" => Ok(value
            .to_owned()
            .try_decode::<Vec<u8>>()
            .map(|bytes| {
                Value::Array(
                    bytes
                        .into_iter()
                        .map(|byte| Value::Number(Number::from(byte)))
                        .collect(),
                )
            })
            .unwrap_or(Value::Null)),
        "NULL" => Ok(Value::Null),
        unsupported => Err(format!("Unsupported SQLite datatype: {unsupported}")),
    }
}

#[tauri::command]
pub async fn select_local_mode_sqlite_transaction(
    state: State<'_, LocalModeSqliteTransactionState>,
    transaction_id: String,
    query: String,
    values: Vec<Value>,
) -> Result<Vec<Value>, String> {
    let mut transactions = state.transactions.lock().await;
    let transaction = transactions
        .get_mut(&transaction_id)
        .ok_or_else(|| "The SQLite transaction is no longer active.".to_string())?;
    let rows = bind_values(sqlx::query(&query), values)
        .fetch_all(&mut **transaction)
        .await
        .map_err(|error| error.to_string())?;

    rows.into_iter()
        .map(|row| {
            let mut object = Map::new();
            for (index, column) in row.columns().iter().enumerate() {
                let value = row
                    .try_get_raw(index)
                    .map_err(|error| error.to_string())?;
                object.insert(column.name().to_string(), sqlite_value_to_json(value)?);
            }
            Ok(Value::Object(object))
        })
        .collect()
}

#[tauri::command]
pub async fn commit_local_mode_sqlite_transaction(
    state: State<'_, LocalModeSqliteTransactionState>,
    transaction_id: String,
) -> Result<(), String> {
    let transaction = state
        .transactions
        .lock()
        .await
        .remove(&transaction_id)
        .ok_or_else(|| "The SQLite transaction is no longer active.".to_string())?;
    transaction.commit().await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn rollback_local_mode_sqlite_transaction(
    state: State<'_, LocalModeSqliteTransactionState>,
    transaction_id: String,
) -> Result<(), String> {
    let Some(transaction) = state.transactions.lock().await.remove(&transaction_id) else {
        return Ok(());
    };
    transaction.rollback().await.map_err(|error| error.to_string())
}
