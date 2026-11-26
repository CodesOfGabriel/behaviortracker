#[allow(dead_code)]
mod google_client;

fn main() {
    println!("cargo:rerun-if-changed=google_client.rs");
    println!("cargo:rerun-if-env-changed=BEHAVETRACKER_GOOGLE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=BEHAVETRACKER_GOOGLE_CLIENT_SECRET");
    let client_id = std::env::var("BEHAVETRACKER_GOOGLE_CLIENT_ID").unwrap_or_default();
    let client_secret = std::env::var("BEHAVETRACKER_GOOGLE_CLIENT_SECRET").unwrap_or_default();
    if std::env::var("PROFILE").as_deref() == Ok("release")
        || !client_id.is_empty()
        || !client_secret.is_empty()
    {
        if let Err(message) = google_client::validate_credentials(&client_id, &client_secret) {
            panic!("{message}");
        }
    }
    if !client_id.is_empty() {
        println!("cargo:rustc-env=BEHAVETRACKER_GOOGLE_CLIENT_ID={client_id}");
    }
    if !client_secret.is_empty() {
        println!("cargo:rustc-env=BEHAVETRACKER_GOOGLE_CLIENT_SECRET={client_secret}");
    }
    tauri_build::build()
}
