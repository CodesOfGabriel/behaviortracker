mod colab;
mod oauth;
mod video;

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            oauth::get_google_oauth_config,
            oauth::save_google_oauth_config,
            oauth::start_google_auth,
            oauth::restore_legacy_google_session,
            oauth::check_colab_eligibility,
            oauth::disconnect_google_account,
            oauth::delete_google_oauth_config,
            colab::begin_video_staging,
            colab::append_video_staging_chunk,
            colab::finish_video_staging,
            video::prepare_analysis_video,
            video::check_video_staging,
            colab::start_colab_analysis,
            colab::get_colab_job,
            colab::get_colab_job_log,
            colab::get_colab_job_result,
            colab::get_colab_job_video,
            colab::get_colab_diagnostic_result,
            colab::get_latest_colab_job,
            colab::list_colab_jobs
        ])
        .run(tauri::generate_context!())
        .expect("error while running BehaveTracker");
}
