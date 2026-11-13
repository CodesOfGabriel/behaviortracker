mod colab;
mod database;
mod local_tracking;
mod oauth;
mod training;
mod video;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn open_legal_page(app: tauri::AppHandle, page: String) -> Result<(), String> {
    let url = match page.as_str() {
        "privacy" => "https://behavior.usetars.com/privacy",
        "terms" => "https://behavior.usetars.com/terms",
        _ => return Err("Página legal desconhecida.".into()),
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "Não foi possível abrir o navegador padrão.".to_string())
}

#[derive(serde::Serialize)]
struct AppInfo {
    app_version: &'static str,
    schema_version: &'static str,
    analysis_method_version: &'static str,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        app_version: env!("CARGO_PKG_VERSION"),
        schema_version: "1.0",
        analysis_method_version: "oft-0.2",
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            colab::recover_interrupted_jobs(&app.handle()).map_err(std::io::Error::other)?;
            local_tracking::recover(&app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            open_legal_page,
            local_tracking::get_local_tracking_result,
            oauth::get_google_oauth_config,
            oauth::save_google_oauth_config,
            oauth::start_google_auth,
            oauth::restore_legacy_google_session,
            oauth::check_colab_eligibility,
            oauth::disconnect_google_account,
            oauth::delete_google_oauth_config,
            colab::begin_video_staging,
            colab::append_video_staging_chunk,
            colab::append_video_staging_raw,
            colab::finish_video_staging,
            colab::get_video_staging_sha256,
            colab::get_staged_video_path,
            video::prepare_analysis_video,
            video::get_colab_job_preparation,
            video::check_video_staging,
            colab::start_colab_analysis,
            colab::hybrid_bundle_status,
            colab::hybrid_bundle_available,
            colab::import_hybrid_bundle,
            colab::get_colab_job,
            colab::get_colab_job_log,
            colab::get_colab_job_result,
            colab::get_fst_job_artifacts,
            colab::get_fst_job_manifest,
            colab::get_colab_job_video,
            colab::get_latest_colab_job,
            colab::list_colab_jobs
        ])
        .run(tauri::generate_context!())
        .expect("error while running Behavior Tracker");
}
