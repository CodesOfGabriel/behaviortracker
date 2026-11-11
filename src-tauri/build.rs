fn main() {
    println!("cargo:rerun-if-env-changed=BEHAVETRACKER_GOOGLE_CLIENT_ID");
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        let client_id = std::env::var("BEHAVETRACKER_GOOGLE_CLIENT_ID").unwrap_or_default();
        assert!(
            client_id.trim() == client_id
                && client_id.ends_with(".apps.googleusercontent.com")
                && !client_id.chars().any(char::is_whitespace),
            "Defina BEHAVETRACKER_GOOGLE_CLIENT_ID com o OAuth Client ID Desktop do Behavior Tracker antes de gerar o instalador."
        );
    }
    tauri_build::build()
}
