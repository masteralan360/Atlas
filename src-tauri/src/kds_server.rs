use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
        Request,
    },
    response::IntoResponse,
    routing::get,
    middleware::{self, Next},
    Router,
};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::cors::CorsLayer;
use tauri::{AppHandle, Manager, Emitter};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KdsMessage {
    pub event: String,
    pub payload: serde_json::Value,
}

pub struct AppState {
    pub tx: broadcast::Sender<String>,
    pub last_message: Arc<Mutex<Option<String>>>,
    pub app_handle: AppHandle,
}

pub async fn start_server(app_handle: AppHandle, port: u16, tx: broadcast::Sender<String>, last_message: Arc<Mutex<Option<String>>>) -> Result<String, String> {
    let app_state = Arc::new(AppState { tx: tx.clone(), last_message, app_handle: app_handle.clone() });

    // Determine local IP
    let local_ip = if_addrs::get_if_addrs()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|iface| !iface.is_loopback() && iface.ip().is_ipv4())
        .map(|iface| iface.ip().to_string())
        .unwrap_or_else(|| "127.0.0.1".to_string());

    // Search for dist directory
    let mut dist_path = std::env::current_dir()
        .unwrap_or_default()
        .join("dist");

    // If current_dir is src-tauri, dist is in the parent.
    if !dist_path.exists() {
        if let Ok(pwd) = std::env::current_dir() {
            let alt_dist = pwd.join("..").join("dist");
            if alt_dist.exists() {
                dist_path = alt_dist; // Found it at ../dist
            }
        }
    }

    // Tauri packaged fallback
    if !dist_path.exists() {
        if let Ok(res_path) = app_handle.path().resource_dir() {
            dist_path = res_path.join("dist");
            
            if !dist_path.exists() {
                if let Some(parent) = res_path.parent() {
                    let alt_dist = parent.join("dist");
                    if alt_dist.exists() {
                        dist_path = alt_dist;
                    }
                }
            }
        }
    }

    println!("[KDS Server] Starting server on {}:{}", local_ip, port);
    println!("[KDS Server] Serving static files from: {:?}", dist_path);
    if !dist_path.exists() {
        println!("[KDS Server] WARNING: dist directory does not exist at {:?}!", dist_path);
    }

    let serve_dir = ServeDir::new(&dist_path)
        .fallback(ServeFile::new(dist_path.join("index.html")));

    let app = Router::new()
        .fallback_service(serve_dir)
        .route("/ws", get(ws_handler))
        .layer(CorsLayer::permissive())
        .layer(middleware::from_fn(log_requests))
        .with_state(app_state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    
    tokio::spawn(async move {
        let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
        axum::serve(listener, app).await.unwrap();
    });

    Ok(format!("http://{}:{}/#/kds/local", local_ip, port))
}

async fn log_requests(req: Request, next: Next) -> axum::response::Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    println!("[KDS HTTP] {} {}", method, uri);
    
    let response = next.run(req).await;
    
    if response.status().is_client_error() || response.status().is_server_error() {
        println!("[KDS HTTP ERROR] {} {} -> {}", method, uri, response.status());
    }
    
    response
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    println!("[KDS WS] New WebSocket connection requested!");
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    use futures_util::{SinkExt, StreamExt};
    
    println!("[KDS WS] Client fully connected!");

    let (mut sender, mut receiver) = socket.split();

    // Replay the last cached state so the new client isn't empty
    let cached_msg = {
        state.last_message.lock().unwrap().clone()
    };
    if let Some(msg) = cached_msg {
        println!("[KDS WS] Sending cached state to new client...");
        let _ = sender.send(Message::Text(msg)).await;
    }

    let mut rx = state.tx.subscribe();

    // Task: forward broadcast messages to this client
    let mut send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    // Task: read messages FROM this client (remote → main)
    let tx_clone = state.tx.clone();
    let last_msg_clone = state.last_message.clone();
    let app_handle_clone = state.app_handle.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if let Message::Text(text) = msg {
                println!("[KDS WS] Received message from remote client");
                // Cache and rebroadcast to all clients (including the main terminal's WS if connected)
                if let Ok(mut cached) = last_msg_clone.lock() {
                    *cached = Some(text.clone());
                }
                let _ = tx_clone.send(text.clone());
                // Emit Tauri event so the main window picks it up
                let _ = app_handle_clone.emit("kds-remote-update", text);
            }
        }
    });

    // Wait for either task to end
    tokio::select! {
        _ = (&mut send_task) => {
            recv_task.abort();
        },
        _ = (&mut recv_task) => {
            send_task.abort();
        },
    }
    println!("[KDS WS] Client connection closed.");
}

pub fn broadcast_message(state: &AppState, message: KdsMessage) -> Result<(), String> {
    let json = serde_json::to_string(&message).map_err(|e| e.to_string())?;
    // Cache the last message for new connections
    if let Ok(mut cached) = state.last_message.lock() {
        *cached = Some(json.clone());
    }
    let _ = state.tx.send(json);
    Ok(())
}
