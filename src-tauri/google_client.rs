// Shared by the installer build and the OAuth runtime. Credentials belong to
// the application build, never to a researcher's local configuration.
pub fn validate_credentials(client_id: &str, client_secret: &str) -> Result<(), &'static str> {
    if client_id.len() > 512
        || client_id.trim() != client_id
        || !client_id.ends_with(".apps.googleusercontent.com")
        || client_id.len() <= ".apps.googleusercontent.com".len()
        || client_id.chars().any(char::is_whitespace)
    {
        return Err(
            "BEHAVETRACKER_GOOGLE_CLIENT_ID deve conter o OAuth Client ID Desktop do aplicativo.",
        );
    }
    if client_secret.trim().is_empty()
        || client_secret.trim() != client_secret
        || client_secret.len() > 2048
        || client_secret.contains(['\n', '\r'])
    {
        return Err("BEHAVETRACKER_GOOGLE_CLIENT_SECRET deve conter o Client Secret OAuth Desktop do aplicativo.");
    }
    Ok(())
}

pub fn credentials_from_build() -> Option<(&'static str, &'static str)> {
    let client_id = option_env!("BEHAVETRACKER_GOOGLE_CLIENT_ID")?;
    let client_secret = option_env!("BEHAVETRACKER_GOOGLE_CLIENT_SECRET")?;
    validate_credentials(client_id, client_secret).ok()?;
    Some((client_id, client_secret))
}

pub fn secret_for_client<'a>(client_id: &str, bundled: Option<(&str, &'a str)>) -> Option<&'a str> {
    bundled
        .filter(|(id, _)| *id == client_id)
        .map(|(_, secret)| secret)
}
