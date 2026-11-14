fn main() {
    println!("cargo:rerun-if-env-changed=BEHAVETRACKER_GOOGLE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=BEHAVETRACKER_GOOGLE_CLIENT_SECRET");
    let client_id = std::env::var("BEHAVETRACKER_GOOGLE_CLIENT_ID").unwrap_or_default();
    let client_secret = std::env::var("BEHAVETRACKER_GOOGLE_CLIENT_SECRET").unwrap_or_default();
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        assert!(
            client_id.trim() == client_id
                && client_id.ends_with(".apps.googleusercontent.com")
                && !client_id.chars().any(char::is_whitespace),
            "Defina BEHAVETRACKER_GOOGLE_CLIENT_ID com o OAuth Client ID Desktop do Behavior Tracker antes de gerar o instalador."
        );
        assert!(
            !client_secret.trim().is_empty()
                && client_secret == client_secret.trim()
                && !client_secret
                    .chars()
                    .any(|character| matches!(character, '\n' | '\r')),
            "Defina BEHAVETRACKER_GOOGLE_CLIENT_SECRET com o Client Secret OAuth Desktop do Behavior Tracker antes de gerar o instalador."
        );
    }
    if !client_id.is_empty() {
        println!("cargo:rustc-env=BEHAVETRACKER_GOOGLE_CLIENT_ID={client_id}");
    }
    if !client_secret.is_empty() {
        println!("cargo:rustc-env=BEHAVETRACKER_GOOGLE_CLIENT_SECRET={client_secret}");
    }
    tauri_build::build()
}
