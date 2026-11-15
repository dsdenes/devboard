//! Provider credentials, masked views, and the five provider wire commands.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use devboard::app::{App, Conn};
use devboard::command::Command;
use devboard::config::Config;
use devboard::journal::Journal;
use devboard::providers::{
    credentials_backup_path, credentials_lost, credentials_marker_path, credentials_path,
    load_subscriptions, lost_credentials_message, save_subscriptions, worker_peer_environment,
    write_selection_snapshot, AuditSink, CredentialSource, ProviderAudit, ProviderChangeError,
    ProviderId, ProviderOptions, ProviderService, SaveProviderInput, StoredSubscription, Transport,
    TransportError, TransportFuture, UsageResponse, UsageStatus, PROVIDER_CHANGE_NEEDS_ID,
};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;

fn fixture_root(label: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".test-tmp")
        .join(format!("providers-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("repo")).expect("a fixture root");
    std::fs::create_dir_all(root.join("state")).expect("a fixture state");
    root
}

type Calls = Arc<Mutex<Vec<String>>>;

fn stub_transport(calls: Calls) -> Transport {
    Arc::new(move |request| -> TransportFuture {
        let calls = calls.clone();
        Box::pin(async move {
            calls
                .lock()
                .expect("calls")
                .push(format!("{} {}", request.url, request.key));
            if request.url.ends_with("/v1/usage") {
                let body = json!({
                    "usage": {
                        "rolling": {"percent": 50, "status": "ok", "resetsAt": "2030-01-01T00:00:00Z"},
                        "weekly": {"percent": 90, "status": "ok", "resetsAt": "2030-01-07T00:00:00Z"},
                        "monthly": {"percent": 80, "status": "ok", "resetsAt": "2030-02-01T00:00:00Z"}
                    }
                })
                .to_string();
                return Ok(UsageResponse { status: 200, body });
            }
            if request.url.ends_with("/v1/key") {
                let body = json!({"data": {"limit": 100, "limit_remaining": 25}}).to_string();
                return Ok(UsageResponse { status: 200, body });
            }
            Ok(UsageResponse {
                status: 404,
                body: String::new(),
            })
        })
    })
}

fn service_at(state: &Path, repo: &Path, calls: Calls) -> ProviderService {
    let mut options = ProviderOptions {
        env: Some(HashMap::new()),
        transport: Some(stub_transport(calls)),
        ..ProviderOptions::default()
    };
    options.usage_base_urls.insert(
        ProviderId::OpenCodeGo,
        "http://stub.test/zen/go".to_string(),
    );
    options
        .usage_base_urls
        .insert(ProviderId::OpenRouter, "http://stub.test/api".to_string());
    ProviderService::with_options(state, repo, options)
}

type Audits = Arc<Mutex<Vec<ProviderAudit>>>;

fn collecting_audit() -> (AuditSink, Audits) {
    let audits: Audits = Arc::new(Mutex::new(Vec::new()));
    let sink: AuditSink = {
        let audits = Arc::clone(&audits);
        Arc::new(move |audit| audits.lock().expect("audits").push(audit))
    };
    (sink, audits)
}

fn service_with_audit(
    state: &Path,
    repo: &Path,
    calls: Calls,
    audit: AuditSink,
) -> ProviderService {
    let mut options = ProviderOptions {
        env: Some(HashMap::new()),
        transport: Some(stub_transport(calls)),
        audit: Some(audit),
        ..ProviderOptions::default()
    };
    options.usage_base_urls.insert(
        ProviderId::OpenCodeGo,
        "http://stub.test/zen/go".to_string(),
    );
    options
        .usage_base_urls
        .insert(ProviderId::OpenRouter, "http://stub.test/api".to_string());
    ProviderService::with_options(state, repo, options)
}

fn loss_count(audits: &Audits) -> usize {
    audits
        .lock()
        .expect("audits")
        .iter()
        .filter(|audit| matches!(audit, ProviderAudit::Loss { .. }))
        .count()
}

fn activity_count(audits: &Audits) -> usize {
    audits
        .lock()
        .expect("audits")
        .iter()
        .filter(|audit| matches!(audit, ProviderAudit::Activity(_)))
        .count()
}

fn assert_credentials_pair(state: &Path) {
    let primary_path = credentials_path(state);
    let backup_path = credentials_backup_path(state);
    let primary = std::fs::read(&primary_path).expect("the primary credentials");
    let backup = std::fs::read(&backup_path).expect("the backup credentials");
    assert_eq!(
        primary, backup,
        "the two credential files are byte-identical"
    );
    assert!(
        credentials_marker_path(state).exists(),
        "the presence marker exists"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let directory = std::fs::metadata(state.join("providers")).expect("the directory");
        assert_eq!(directory.permissions().mode() & 0o777, 0o700);
        for path in [&primary_path, &backup_path] {
            let file = std::fs::metadata(path).expect("a credential file");
            assert_eq!(file.permissions().mode() & 0o777, 0o600);
        }
    }
}

fn empty_service(label: &str) -> (ProviderService, PathBuf) {
    let root = fixture_root(label);
    let service = service_at(
        &root.join("state"),
        &root.join("repo"),
        Arc::new(Mutex::new(Vec::new())),
    );
    (service, root)
}

fn connection() -> (Conn, UnboundedReceiver<String>) {
    let (outbox, inbox) = tokio::sync::mpsc::unbounded_channel();
    (Conn::new(outbox), inbox)
}

fn frame(inbox: &mut UnboundedReceiver<String>) -> Value {
    let text = inbox.try_recv().expect("a frame");
    serde_json::from_str(&text).expect("a JSON frame")
}

fn all_frames(inbox: &mut UnboundedReceiver<String>) -> Vec<String> {
    let mut frames = Vec::new();
    while let Ok(text) = inbox.try_recv() {
        frames.push(text);
    }
    frames
}

fn subscription(id: &str, provider: ProviderId, key: &str) -> StoredSubscription {
    StoredSubscription {
        id: id.to_string(),
        provider,
        label: id.to_string(),
        key: key.to_string(),
        enabled: true,
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        updated_at: "2026-01-01T00:00:00.000Z".to_string(),
    }
}

async fn save(
    service: &ProviderService,
    provider: &str,
    label: &str,
    key: &str,
) -> Result<(), String> {
    service
        .save(SaveProviderInput {
            id: None,
            provider: Some(json!(provider)),
            label: Some(json!(label)),
            key: Some(json!(key)),
        })
        .await
        .map_err(|error| error.message)
}

#[test]
fn catalog_lists_exactly_the_two_providers() {
    let root = fixture_root("catalog");
    let service = ProviderService::new(root.join("state"), root.join("repo"), |_: &str| {});
    let view = service.view();
    assert!(view.subscriptions.is_empty());
    assert!(view.selection.is_none());
    assert_eq!(
        view.refusal.as_deref(),
        Some(
            "No provider is configured. Open the Providers dialog (settings.providers) and add \
             an OpenCode Go or OpenRouter API key."
        )
    );
    assert_eq!(view.rule, "rotates at 1% remaining");

    let go = devboard::providers::provider_definition(ProviderId::OpenCodeGo);
    assert_eq!(go.name, "OpenCode Go");
    assert_eq!(go.env_var, "OPENCODE_API_KEY");
    assert_eq!(go.model, "opencode-go/deepseek-v4.1-flash");
    assert_eq!(go.usage_path, "/v1/usage");
    assert_eq!(
        go.windows
            .iter()
            .map(|window| window.key)
            .collect::<Vec<_>>(),
        ["rolling", "weekly", "monthly"]
    );
    let openrouter = devboard::providers::provider_definition(ProviderId::OpenRouter);
    assert_eq!(openrouter.name, "OpenRouter");
    assert_eq!(openrouter.env_var, "OPENROUTER_API_KEY");
    assert_eq!(
        openrouter.model,
        "openrouter/deepseek/deepseek-v4.1-flash-1017"
    );
    assert_eq!(openrouter.usage_path, "/v1/key");
}

#[tokio::test]
async fn save_then_list_masks_the_key_and_writes_private_files() {
    let root = fixture_root("save");
    let state = root.join("state");
    let service = service_at(&state, &root.join("repo"), Arc::new(Mutex::new(Vec::new())));

    save(&service, "opencode-go", "main", "sk-test-abcd1234")
        .await
        .expect("the provider saves");

    let stored = service.list();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].label, "main");
    assert_eq!(stored[0].key, "sk-test-abcd1234");
    assert!(stored[0].enabled);

    let view = service.view();
    assert_eq!(view.subscriptions[0].masked_key, "••••1234");
    assert!(
        !devboard::jsjson::stringify(&view.to_json()).contains("sk-test-abcd1234"),
        "the masked view never carries the full key"
    );
    assert_eq!(
        service.view().subscriptions[0].status,
        UsageStatus::NearLimit
    );

    let credentials = state.join("providers/credentials.json");
    let text = std::fs::read_to_string(&credentials).expect("credentials");
    assert!(text.contains("sk-test-abcd1234"));
    assert!(text.contains("\"version\": 1"));
    assert!(text.contains("\"provider\": \"opencode-go\""));
    let reloaded = load_subscriptions(&state);
    assert_eq!(reloaded.subscriptions.len(), 1);
    assert_eq!(reloaded.subscriptions[0].key, "sk-test-abcd1234");
    assert!(reloaded.preserved.is_none());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let directory = std::fs::metadata(state.join("providers")).expect("directory");
        assert_eq!(directory.permissions().mode() & 0o777, 0o700);
        let file = std::fs::metadata(&credentials).expect("file");
        assert_eq!(file.permissions().mode() & 0o777, 0o600);
    }
}

#[tokio::test]
async fn delete_removes_the_subscription_and_its_file_entry() {
    let root = fixture_root("delete");
    let state = root.join("state");
    let service = service_at(&state, &root.join("repo"), Arc::new(Mutex::new(Vec::new())));
    save(&service, "openrouter", "fallback", "or-test-9999")
        .await
        .expect("the provider saves");
    let id = service.list()[0].id.clone();

    service.remove(&id).expect("the subscription is removed");
    assert!(service.list().is_empty());
    assert!(service.view().subscriptions.is_empty());
    assert!(load_subscriptions(&state).subscriptions.is_empty());
    assert_eq!(
        service.remove(&id),
        Err(ProviderChangeError::new(
            "That subscription no longer exists."
        ))
    );
}

#[tokio::test]
async fn enable_and_disable_flip_the_stored_flag() {
    let root = fixture_root("enable");
    let state = root.join("state");
    let service = service_at(&state, &root.join("repo"), Arc::new(Mutex::new(Vec::new())));
    save(&service, "opencode-go", "main", "sk-test-abcd1234")
        .await
        .expect("the provider saves");
    let id = service.list()[0].id.clone();

    service.set_enabled(&id, false).expect("disabling works");
    assert!(!service.list()[0].enabled);
    assert!(!service.view().subscriptions[0].enabled);
    assert!(!load_subscriptions(&state).subscriptions[0].enabled);

    service.set_enabled(&id, true).expect("enabling works");
    assert!(service.list()[0].enabled);
    assert_eq!(
        service.set_enabled("missing", true),
        Err(ProviderChangeError::new(
            "That subscription no longer exists."
        ))
    );
}

#[tokio::test]
async fn missing_request_ids_refuse_without_applying_the_change() {
    let (service, _root) = empty_service("request-id");
    let (conn, mut inbox) = connection();

    let save = Command::SaveProvider {
        request_id: None,
        id: None,
        provider: Some(json!("openrouter")),
        label: None,
        key: Some(json!("sk-contract")),
    };
    assert!(service.handle(&conn, &save).await);
    assert_eq!(
        frame(&mut inbox),
        json!({"type": "providerError", "message": PROVIDER_CHANGE_NEEDS_ID})
    );
    assert!(service.list().is_empty(), "a refused change writes nothing");

    let delete = Command::DeleteProvider {
        request_id: Some(json!(3)),
        id: None,
    };
    assert!(service.handle(&conn, &delete).await);
    assert_eq!(
        frame(&mut inbox),
        json!({
            "type": "providerError",
            "requestId": 3,
            "message": "A delete needs the subscription id."
        })
    );

    let enabled = Command::SetProviderEnabled {
        request_id: Some(json!(4)),
        id: Some(json!("x")),
        enabled: None,
    };
    assert!(service.handle(&conn, &enabled).await);
    assert_eq!(
        frame(&mut inbox),
        json!({
            "type": "providerError",
            "requestId": 4,
            "message": "Enabling a subscription needs its id and a boolean."
        })
    );

    let non_provider = Command::GetProject;
    assert!(!service.handle(&conn, &non_provider).await);
    assert!(inbox.try_recv().is_err());
}

#[tokio::test]
async fn corpus_refusal_frames_match_the_recordings() {
    let (service, _root) = empty_service("corpus");

    let (conn, mut inbox) = connection();
    assert!(service.handle(&conn, &Command::GetProviders).await);
    let raw = inbox.try_recv().expect("the state frame");
    assert_eq!(
        raw,
        r#"{"type":"providersState","subscriptions":[],"selection":null,"refusal":"No provider is configured. Open the Providers dialog (settings.providers) and add an OpenCode Go or OpenRouter API key.","rule":"rotates at 1% remaining"}"#
    );

    assert!(service.handle(&conn, &Command::RefreshProviders).await);
    assert_eq!(inbox.try_recv().expect("the state frame"), raw);

    let save = Command::SaveProvider {
        request_id: Some(json!(1)),
        id: Some(json!("missing")),
        provider: Some(json!("openrouter")),
        label: Some(json!("contract")),
        key: Some(json!("sk-contract")),
    };
    assert!(service.handle(&conn, &save).await);
    assert_eq!(
        inbox.try_recv().expect("the refusal"),
        r#"{"type":"providerError","requestId":1,"message":"That subscription no longer exists."}"#
    );

    let delete = Command::DeleteProvider {
        request_id: Some(json!(1)),
        id: Some(json!("missing")),
    };
    assert!(service.handle(&conn, &delete).await);
    assert_eq!(
        inbox.try_recv().expect("the refusal"),
        r#"{"type":"providerError","requestId":1,"message":"That subscription no longer exists."}"#
    );

    let enabled = Command::SetProviderEnabled {
        request_id: Some(json!(1)),
        id: Some(json!("missing")),
        enabled: Some(json!(false)),
    };
    assert!(service.handle(&conn, &enabled).await);
    assert_eq!(
        inbox.try_recv().expect("the refusal"),
        r#"{"type":"providerError","requestId":1,"message":"That subscription no longer exists."}"#
    );
}

#[tokio::test]
async fn a_change_answers_before_the_masked_state() {
    let root = fixture_root("change");
    let service = service_at(
        &root.join("state"),
        &root.join("repo"),
        Arc::new(Mutex::new(Vec::new())),
    );
    let (conn, mut inbox) = connection();

    let save = Command::SaveProvider {
        request_id: Some(json!(7)),
        id: None,
        provider: Some(json!("opencode-go")),
        label: Some(json!("main")),
        key: Some(json!("sk-test-abcd1234")),
    };
    assert!(service.handle(&conn, &save).await);
    let frames = all_frames(&mut inbox);
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0], r#"{"type":"providerChanged","requestId":7}"#);
    let state: Value = serde_json::from_str(&frames[1]).expect("state");
    assert_eq!(state["type"], "providersState");
    assert_eq!(state["subscriptions"][0]["maskedKey"], "••••1234");
    assert_eq!(state["subscriptions"][0]["providerName"], "OpenCode Go");
    assert!(state["selection"].is_object());
    assert!(!frames[1].contains("sk-test-abcd1234"));

    let id = service.list()[0].id.clone();
    let enabled = Command::SetProviderEnabled {
        request_id: Some(json!(8)),
        id: Some(json!(id)),
        enabled: Some(json!(false)),
    };
    assert!(service.handle(&conn, &enabled).await);
    let frames = all_frames(&mut inbox);
    assert_eq!(frames[0], r#"{"type":"providerChanged","requestId":8}"#);
    let state: Value = serde_json::from_str(&frames[1]).expect("state");
    assert_eq!(state["subscriptions"][0]["enabled"], false);

    let delete = Command::DeleteProvider {
        request_id: Some(json!(9)),
        id: Some(json!(service.list()[0].id)),
    };
    assert!(service.handle(&conn, &delete).await);
    let frames = all_frames(&mut inbox);
    assert_eq!(frames[0], r#"{"type":"providerChanged","requestId":9}"#);
    let state: Value = serde_json::from_str(&frames[1]).expect("state");
    assert_eq!(state["subscriptions"], json!([]));
}

#[tokio::test]
async fn usage_refresh_parses_the_stub_and_honours_the_ttl() {
    let root = fixture_root("usage");
    let state = root.join("state");
    save_subscriptions(
        &state,
        &[
            subscription("go", ProviderId::OpenCodeGo, "go-key-0001"),
            subscription("or", ProviderId::OpenRouter, "or-key-0002"),
        ],
    )
    .expect("credentials");
    let calls: Calls = Arc::new(Mutex::new(Vec::new()));
    let service = service_at(&state, &root.join("repo"), calls.clone());

    service.refresh(true).await;
    let view = service.view();
    assert_eq!(view.subscriptions.len(), 2);
    let go = &view.subscriptions[0];
    assert_eq!(
        go.windows
            .iter()
            .map(|window| window.key.as_str())
            .collect::<Vec<_>>(),
        ["rolling", "weekly", "monthly"]
    );
    assert_eq!(go.windows[0].label, "Rolling 5h");
    assert_eq!(go.windows[0].percent_used, Some(50.0));
    assert!((go.remaining_fraction.expect("headroom") - 0.1).abs() < 1e-9);
    assert_eq!(go.status, UsageStatus::NearLimit);
    assert!(go.error.is_none());
    assert!(go.last_checked_at.is_some());

    let openrouter = &view.subscriptions[1];
    assert_eq!(openrouter.windows.len(), 1);
    assert_eq!(openrouter.windows[0].label, "Account limit");
    assert!((openrouter.remaining_fraction.expect("headroom") - 0.25).abs() < 1e-9);
    assert_eq!(openrouter.status, UsageStatus::Ok);

    let selection = view.selection.expect("a selection");
    assert_eq!(selection.provider, ProviderId::OpenCodeGo);
    assert_eq!(selection.model, "opencode-go/deepseek-v4.1-flash");
    assert!((selection.remaining_fraction.expect("headroom") - 0.1).abs() < 1e-9);

    assert_eq!(calls.lock().expect("calls").len(), 2);
    service.refresh(false).await;
    assert_eq!(
        calls.lock().expect("calls").len(),
        2,
        "cached usage is reused"
    );
    service.refresh(true).await;
    assert_eq!(
        calls.lock().expect("calls").len(),
        4,
        "forced usage is refetched"
    );
}

#[tokio::test]
async fn an_invalid_key_is_never_saved() {
    let root = fixture_root("invalid");
    let state = root.join("state");
    let transport: Transport = Arc::new(|_request| -> TransportFuture {
        Box::pin(async move {
            Ok(UsageResponse {
                status: 401,
                body: "{\"error\":{\"message\":\"no\"}}".to_string(),
            })
        })
    });
    let mut options = ProviderOptions {
        env: Some(HashMap::new()),
        transport: Some(transport),
        ..ProviderOptions::default()
    };
    options.usage_base_urls.insert(
        ProviderId::OpenCodeGo,
        "http://stub.test/zen/go".to_string(),
    );
    let service = ProviderService::with_options(&state, root.join("repo"), options);

    assert_eq!(
        save(&service, "opencode-go", "main", "sk-rejected-0001").await,
        Err("The provider rejected this key (HTTP 401).".to_string())
    );
    assert!(service.list().is_empty());
    assert!(load_subscriptions(&state).subscriptions.is_empty());
}

#[tokio::test]
async fn a_refused_key_is_answered_as_the_operator_input_error_it_is() {
    let root = fixture_root("refused-frame");
    let transport: Transport = Arc::new(|_request| -> TransportFuture {
        Box::pin(async move {
            Ok(UsageResponse {
                status: 401,
                body: "{\"error\":{\"message\":\"invalid key\"}}".to_string(),
            })
        })
    });
    let mut options = ProviderOptions {
        env: Some(HashMap::new()),
        transport: Some(transport),
        ..ProviderOptions::default()
    };
    options.usage_base_urls.insert(
        ProviderId::OpenCodeGo,
        "http://stub.test/zen/go".to_string(),
    );
    let service = ProviderService::with_options(root.join("state"), root.join("repo"), options);
    let (conn, mut inbox) = connection();

    let save = Command::SaveProvider {
        request_id: Some(json!(12)),
        id: None,
        provider: Some(json!("opencode-go")),
        label: Some(json!("main")),
        key: Some(json!("sk-typo-0001")),
    };
    assert!(service.handle(&conn, &save).await);
    assert_eq!(
        frame(&mut inbox),
        json!({
            "type": "providerError",
            "requestId": 12,
            "message": "The provider rejected this key (HTTP 401).",
            "keyRefused": true
        })
    );
    assert!(
        inbox.try_recv().is_err(),
        "a refused key answers once and stores nothing"
    );
    assert!(service.list().is_empty());
}

#[tokio::test]
async fn concurrent_refreshes_share_one_upstream_fetch() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let root = fixture_root("single-flight");
    let state = root.join("state");
    save_subscriptions(
        &state,
        &[
            subscription("first", ProviderId::OpenCodeGo, "shared-key-0001"),
            subscription("second", ProviderId::OpenCodeGo, "shared-key-0001"),
        ],
    )
    .expect("credentials");
    let calls = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let transport: Transport = {
        let calls = Arc::clone(&calls);
        let entered = Arc::clone(&entered);
        let release = Arc::clone(&release);
        Arc::new(move |_request| -> TransportFuture {
            let calls = Arc::clone(&calls);
            let entered = Arc::clone(&entered);
            let release = Arc::clone(&release);
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                entered.notify_one();
                release.notified().await;
                Ok(UsageResponse {
                    status: 200,
                    body: json!({
                        "usage": {
                            "rolling": {"percent": 10, "status": "ok"},
                            "weekly": {"percent": 20, "status": "ok"},
                            "monthly": {"percent": 30, "status": "ok"}
                        }
                    })
                    .to_string(),
                })
            })
        })
    };
    let mut options = ProviderOptions {
        env: Some(HashMap::new()),
        transport: Some(transport),
        ..ProviderOptions::default()
    };
    options.usage_base_urls.insert(
        ProviderId::OpenCodeGo,
        "http://stub.test/zen/go".to_string(),
    );
    let service = Arc::new(ProviderService::with_options(
        &state,
        root.join("repo"),
        options,
    ));

    let first = {
        let service = Arc::clone(&service);
        tokio::spawn(async move { service.refresh(true).await })
    };
    let second = {
        let service = Arc::clone(&service);
        tokio::spawn(async move { service.refresh(true).await })
    };
    entered.notified().await;
    // Let the second refresh join the in-flight request before it resolves.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    release.notify_waiters();
    first.await.expect("the first refresh");
    second.await.expect("the second refresh");

    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "two concurrent subscriptions to one provider key share one fetch"
    );
    let view = service.view();
    assert_eq!(view.subscriptions.len(), 2);
    for subscription in &view.subscriptions {
        assert!(subscription.last_checked_at.is_some());
        assert!(subscription.error.is_none());
    }
}

#[test]
fn injected_transport_errors_stay_unknown() {
    let root = fixture_root("transport-error");
    let state = root.join("state");
    save_subscriptions(
        &state,
        &[subscription("go", ProviderId::OpenCodeGo, "go-key-0001")],
    )
    .expect("credentials");
    let transport: Transport = Arc::new(|_request| -> TransportFuture {
        Box::pin(async move { Err(TransportError::Timeout) })
    });
    let options = ProviderOptions {
        env: Some(HashMap::new()),
        transport: Some(transport),
        ..ProviderOptions::default()
    };
    let runtime = tokio::runtime::Runtime::new().expect("a runtime");
    let service = ProviderService::with_options(&state, root.join("repo"), options);
    runtime.block_on(service.refresh(true));
    let view = service.view();
    assert_eq!(view.subscriptions[0].status, UsageStatus::Unknown);
    assert_eq!(view.subscriptions[0].remaining_fraction, None);
    assert_eq!(
        view.subscriptions[0].error.as_deref(),
        Some("The usage check timed out.")
    );
}

#[tokio::test]
async fn a_start_never_waits_for_the_usage_transport() {
    use std::future::pending;

    let root = fixture_root("start-usage");
    let state = root.join("state");
    save_subscriptions(
        &state,
        &[subscription("go", ProviderId::OpenCodeGo, "go-key-0001")],
    )
    .expect("credentials");

    // The injected transport never answers: any await on it would hang.
    let transport: Transport = Arc::new(|_request| -> TransportFuture {
        Box::pin(async move { pending::<Result<UsageResponse, TransportError>>().await })
    });
    let mut options = ProviderOptions {
        env: Some(HashMap::new()),
        transport: Some(transport),
        ..ProviderOptions::default()
    };
    options.usage_base_urls.insert(
        ProviderId::OpenCodeGo,
        "http://stub.test/zen/go".to_string(),
    );
    let service = Arc::new(ProviderService::with_options(
        &state,
        root.join("repo"),
        options,
    ));

    // Selection reads the cached report and returns even though no usage read
    // has ever completed.
    let selected = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        service.select_environment(),
    )
    .await
    .expect("select_environment awaited the usage transport")
    .expect("a selection");
    assert_eq!(
        selected
            .get("OPENCODE_API_KEY")
            .and_then(|value| value.as_deref()),
        Some("go-key-0001")
    );

    // The same environment powers a Start; the spawn happens without the
    // transport answering.
    std::fs::create_dir_all(root.join("repo/.devboard")).expect("a harness directory");
    let config = Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: root.join("repo/adrs"),
        repo_dir: root.join("repo"),
        goal_file: root.join("repo/GOAL.md"),
        static_dir: None,
        agent_command: "true".to_string(),
        state_dir: state.clone(),
        allowed_hosts: Vec::new(),
        feedback: None,
    };
    let journal = Journal::open(&config.state_dir, &config.repo_dir, 0);
    let app = App::new(config, journal);
    let spawned = Arc::new(AtomicBool::new(false));
    let spawned_for_start = Arc::clone(&spawned);
    devboard::agents_mode::set_spawn(&app, move |_argv, _environment| {
        spawned_for_start.store(true, Ordering::SeqCst);
        Some(std::process::id())
    });
    let preflight: devboard::agents_mode::PreflightCallback =
        Arc::new(|_request| Box::pin(async { Ok("owner/repository".to_string()) }));
    devboard::agents_mode::set_preflight(&app, "dead-code", preflight);
    let service_for_start = Arc::clone(&service);
    devboard::agents_mode::set_agent_environment(&app, move || {
        let service = Arc::clone(&service_for_start);
        Box::pin(async move {
            service
                .select_environment()
                .await
                .map(|environment| {
                    environment
                        .into_iter()
                        .filter_map(|(key, value)| value.map(|value| (key, value)))
                        .collect()
                })
                .map_err(|error| error.to_string())
        })
    });

    let (conn, mut inbox) = connection();
    app.register(conn.clone()).await;
    tokio::time::timeout(
        std::time::Duration::from_millis(500),
        devboard::agents_mode::handle(
            &app,
            &conn,
            &Command::StartAgent {
                id: Some(json!("dead-code")),
            },
        ),
    )
    .await
    .expect("a start waited for the usage transport");
    // The spawn runs beside the answer: await the flag it sets.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !spawned.load(Ordering::SeqCst) {
        assert!(
            std::time::Instant::now() < deadline,
            "the start never reached its spawn"
        );
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let all = all_frames(&mut inbox);
    let refused: Vec<Value> = all
        .iter()
        .filter_map(|frame| serde_json::from_str::<Value>(frame).ok())
        .filter(|frame| frame["type"] == "error")
        .collect();
    assert!(refused.is_empty(), "start refused: {refused:?}");
}

#[tokio::test]
async fn the_background_refresh_checks_stale_usage() {
    let root = fixture_root("background-usage");
    let state = root.join("state");
    save_subscriptions(
        &state,
        &[subscription("go", ProviderId::OpenCodeGo, "go-key-0001")],
    )
    .expect("credentials");
    let clock = Arc::new(AtomicI64::new(1_700_000_000_000));
    let clock_for_service = Arc::clone(&clock);
    let calls: Calls = Arc::new(Mutex::new(Vec::new()));
    let mut options = ProviderOptions {
        env: Some(HashMap::new()),
        transport: Some(stub_transport(calls.clone())),
        now_ms: Some(Arc::new(move || clock_for_service.load(Ordering::SeqCst))),
        ..ProviderOptions::default()
    };
    options.usage_base_urls.insert(
        ProviderId::OpenCodeGo,
        "http://stub.test/zen/go".to_string(),
    );
    let service = ProviderService::with_options(&state, root.join("repo"), options);

    // The background path is the only reader here: no Start and no
    // getProviders command is sent.
    service.background_refresh().await;
    assert_eq!(calls.lock().expect("calls").len(), 1);
    let first = service.view().subscriptions[0]
        .last_checked_at
        .clone()
        .expect("a checked time");
    assert_eq!(first, devboard::providers::iso_timestamp(1_700_000_000_000));

    // A report younger than the TTL is reused without a provider call.
    clock.fetch_add(59_000, Ordering::SeqCst);
    service.background_refresh().await;
    assert_eq!(calls.lock().expect("calls").len(), 1);

    // One TTL later the background path refreshes the cached report.
    clock.fetch_add(1_000, Ordering::SeqCst);
    service.background_refresh().await;
    assert_eq!(calls.lock().expect("calls").len(), 2);
    let refreshed = service.view().subscriptions[0]
        .last_checked_at
        .clone()
        .expect("a refreshed time");
    assert_eq!(
        refreshed,
        devboard::providers::iso_timestamp(1_700_000_060_000)
    );
}

/// A usage endpoint that never answers must not hold the provider read: the
/// cached view answers. This test compiles against the base handler, where the
/// read awaited the transport, and fails there on the timeout.
#[tokio::test]
async fn a_read_never_waits_for_the_usage_transport() {
    use std::future::pending;

    let root = fixture_root("read-usage");
    let state = root.join("state");
    save_subscriptions(
        &state,
        &[subscription("go", ProviderId::OpenCodeGo, "go-key-0001")],
    )
    .expect("credentials");
    // The injected transport never answers: any await on it would hang.
    let transport: Transport = Arc::new(|_request| -> TransportFuture {
        Box::pin(async move { pending::<Result<UsageResponse, TransportError>>().await })
    });
    let mut options = ProviderOptions {
        env: Some(HashMap::new()),
        transport: Some(transport),
        ..ProviderOptions::default()
    };
    options.usage_base_urls.insert(
        ProviderId::OpenCodeGo,
        "http://stub.test/zen/go".to_string(),
    );
    let service = ProviderService::with_options(&state, root.join("repo"), options);

    let (conn, mut inbox) = connection();
    tokio::time::timeout(
        std::time::Duration::from_millis(500),
        service.handle(&conn, &Command::GetProviders),
    )
    .await
    .expect("getProviders awaited the usage transport");

    let answer = frame(&mut inbox);
    assert_eq!(answer["type"], "providersState");
    assert_eq!(answer["subscriptions"][0]["status"], "unknown");
}

/// A read with a stale cache answers the cached status and makes no provider
/// call at all: the replacement belongs to the background loop.
#[tokio::test]
async fn a_stale_read_serves_the_cached_usage_without_a_provider_call() {
    let root = fixture_root("read-cached");
    let state = root.join("state");
    save_subscriptions(
        &state,
        &[subscription("go", ProviderId::OpenCodeGo, "go-key-0001")],
    )
    .expect("credentials");
    let clock = Arc::new(AtomicI64::new(1_700_000_000_000));
    let clock_for_service = Arc::clone(&clock);
    let calls: Calls = Arc::new(Mutex::new(Vec::new()));
    let mut options = ProviderOptions {
        env: Some(HashMap::new()),
        transport: Some(stub_transport(calls.clone())),
        now_ms: Some(Arc::new(move || clock_for_service.load(Ordering::SeqCst))),
        ..ProviderOptions::default()
    };
    options.usage_base_urls.insert(
        ProviderId::OpenCodeGo,
        "http://stub.test/zen/go".to_string(),
    );
    let service = ProviderService::with_options(&state, root.join("repo"), options);
    service.refresh(true).await;
    assert_eq!(calls.lock().expect("calls").len(), 1);

    // One TTL later the cached report is stale: the read answers it anyway.
    clock.fetch_add(61_000, Ordering::SeqCst);
    let wake = service.refresh_wake();
    let (conn, mut inbox) = connection();
    assert!(service.handle(&conn, &Command::GetProviders).await);
    assert_eq!(
        calls.lock().expect("calls").len(),
        1,
        "a read fetched usage"
    );
    let answer = frame(&mut inbox);
    assert_eq!(answer["type"], "providersState");
    assert_eq!(answer["subscriptions"][0]["status"], "near-limit");
    tokio::time::timeout(std::time::Duration::from_millis(50), wake.notified())
        .await
        .expect("a stale read never asked for a background refresh");
}

#[tokio::test]
async fn a_fresh_connection_receives_no_unsolicited_provider_state() {
    let root = fixture_root("startup-usage");
    let state = root.join("state");
    std::fs::create_dir_all(root.join("repo/.devboard")).expect("a harness directory");
    let config = Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: root.join("repo/adrs"),
        repo_dir: root.join("repo"),
        goal_file: root.join("repo/GOAL.md"),
        static_dir: None,
        agent_command: "true".to_string(),
        state_dir: state.clone(),
        allowed_hosts: Vec::new(),
        feedback: None,
    };
    let journal = Journal::open(&config.state_dir, &config.repo_dir, 0);
    let app = App::new(config, journal);
    let (conn, mut inbox) = connection();
    app.register(conn.clone()).await;

    // The usage push belongs one period after startup; the immediate interval
    // tick must not answer a connection that sent nothing.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let providers: Vec<Value> = all_frames(&mut inbox)
        .iter()
        .filter_map(|frame| serde_json::from_str::<Value>(frame).ok())
        .filter(|frame| frame["type"] == "providersState")
        .collect();
    assert!(
        providers.is_empty(),
        "an unsolicited provider frame arrived before the first period: {providers:?}"
    );
}

/// A worker resolving its own environment has no cached usage, so every Go
/// key reports unknown headroom. It must follow the dashboard's published
/// selection instead of the first key in the credential file: the first key
/// may be an exhausted subscription whose 429 the peer cannot recover from.
#[tokio::test]
async fn a_worker_follows_the_published_selection_when_usage_is_unknown() {
    let root = fixture_root("worker-selection");
    let state = root.join("state");
    save_subscriptions(
        &state,
        &[
            subscription("go-first", ProviderId::OpenCodeGo, "go-key-first"),
            subscription("go-preferred", ProviderId::OpenCodeGo, "go-key-preferred"),
        ],
    )
    .expect("credentials");
    write_selection_snapshot(
        &state,
        ProviderId::OpenCodeGo,
        "go-preferred",
        "Go #4",
        "opencode-go/deepseek-v4.1-flash",
        Some(0.56),
        "2026-11-09T09:56:49.003Z",
    )
    .expect("selection");

    let environment = worker_peer_environment(
        &state,
        &root.join("repo"),
        HashMap::new(),
        ProviderOptions::default(),
    )
    .await
    .expect("a selection");
    assert_eq!(
        environment
            .get("OPENCODE_API_KEY")
            .and_then(|value| value.as_deref()),
        Some("go-key-preferred")
    );
    let directory = environment
        .get("PI_CODING_AGENT_DIR")
        .and_then(|value| value.as_deref())
        .expect("an agent directory");
    assert!(
        directory.ends_with("opencode-go-go-preferred"),
        "{directory}"
    );
}

/// Preference only breaks a tie. Real cached usage still rotates away from a
/// subscription that has run out, even when a stale published selection
/// still names it.
#[tokio::test]
async fn known_usage_outranks_a_stale_published_selection() {
    let root = fixture_root("stale-selection");
    let state = root.join("state");
    save_subscriptions(
        &state,
        &[
            subscription("go-empty", ProviderId::OpenCodeGo, "go-key-empty"),
            subscription("go-headroom", ProviderId::OpenCodeGo, "go-key-headroom"),
        ],
    )
    .expect("credentials");

    let transport: Transport = Arc::new(|request| -> TransportFuture {
        let monthly = if request.key == "go-key-empty" {
            100
        } else {
            44
        };
        Box::pin(async move {
            let body = json!({
                "usage": {
                    "rolling": {"percent": 0, "resetsAt": "2030-01-01T00:00:00Z"},
                    "weekly": {"percent": 0, "resetsAt": "2030-01-07T00:00:00Z"},
                    "monthly": {"percent": monthly, "resetsAt": "2030-02-01T00:00:00Z"}
                }
            })
            .to_string();
            Ok(UsageResponse { status: 200, body })
        })
    });
    let mut options = ProviderOptions {
        env: Some(HashMap::new()),
        transport: Some(transport),
        ..ProviderOptions::default()
    };
    options.usage_base_urls.insert(
        ProviderId::OpenCodeGo,
        "http://stub.test/zen/go".to_string(),
    );
    let service = ProviderService::with_options(&state, root.join("repo"), options);
    service.refresh(true).await;

    write_selection_snapshot(
        &state,
        ProviderId::OpenCodeGo,
        "go-empty",
        "Go empty",
        "opencode-go/deepseek-v4.1-flash",
        Some(0.0),
        "2026-11-09T09:56:49.003Z",
    )
    .expect("stale selection");
    let environment = service.select_environment().await.expect("a selection");
    assert_eq!(
        environment
            .get("OPENCODE_API_KEY")
            .and_then(|value| value.as_deref()),
        Some("go-key-headroom")
    );
}

/// The snapshot decides the provider too when the worker has no usage: after
/// the dashboard rotates from an exhausted Go key to OpenRouter, the next
/// issue run must use OpenRouter instead of the first Go key in the list.
#[tokio::test]
async fn a_worker_follows_a_published_openrouter_selection() {
    let root = fixture_root("worker-openrouter-selection");
    let state = root.join("state");
    save_subscriptions(
        &state,
        &[
            subscription("go-first", ProviderId::OpenCodeGo, "go-key-first"),
            subscription("or-only", ProviderId::OpenRouter, "or-key-only"),
        ],
    )
    .expect("credentials");
    write_selection_snapshot(
        &state,
        ProviderId::OpenRouter,
        "or-only",
        "OpenRouter",
        "openrouter/deepseek/deepseek-v4.1-flash-1017",
        Some(0.79),
        "2026-11-09T09:56:49.003Z",
    )
    .expect("selection");

    let environment = worker_peer_environment(
        &state,
        &root.join("repo"),
        HashMap::new(),
        ProviderOptions::default(),
    )
    .await
    .expect("a selection");
    assert_eq!(
        environment
            .get("OPENROUTER_API_KEY")
            .and_then(|value| value.as_deref()),
        Some("or-key-only")
    );
    assert_eq!(
        environment
            .get("OPENCODE_API_KEY")
            .and_then(|value| value.as_deref()),
        None
    );
}

// ---------------------------------------------------------------------------
// Credential-store durability

#[tokio::test]
async fn every_provider_mutation_writes_identical_private_primary_and_backup() {
    let root = fixture_root("dual-write");
    let state = root.join("state");
    let service = service_at(&state, &root.join("repo"), Arc::new(Mutex::new(Vec::new())));

    save(&service, "opencode-go", "main", "sk-dual-1234")
        .await
        .expect("the provider saves");
    assert_credentials_pair(&state);

    let id = service.list()[0].id.clone();
    service
        .save(SaveProviderInput {
            id: Some(id.clone()),
            provider: Some(json!("opencode-go")),
            label: Some(json!("renamed")),
            key: None,
        })
        .await
        .expect("the label edit saves");
    assert_credentials_pair(&state);

    service.set_enabled(&id, false).expect("disable saves");
    assert_credentials_pair(&state);

    service.remove(&id).expect("delete saves");
    assert_credentials_pair(&state);
    assert!(load_subscriptions(&state).subscriptions.is_empty());
}

#[tokio::test]
async fn a_failed_write_changes_neither_file_and_is_not_adopted() {
    let root = fixture_root("write-failure");
    let state = root.join("state");
    let service = service_at(&state, &root.join("repo"), Arc::new(Mutex::new(Vec::new())));
    save(&service, "opencode-go", "main", "sk-failure-1234")
        .await
        .expect("the provider saves");
    let id = service.list()[0].id.clone();
    let primary_path = credentials_path(&state);
    let backup_path = credentials_backup_path(&state);
    let primary_before = std::fs::read(&primary_path).expect("the primary");
    let backup_before = std::fs::read(&backup_path).expect("the backup");

    // A directory where the primary belongs makes its rename fail after the
    // backup rename has succeeded, exercising the rollback.
    std::fs::remove_file(&primary_path).expect("remove the primary");
    std::fs::create_dir(&primary_path).expect("a directory in its place");

    let error = service
        .set_enabled(&id, false)
        .expect_err("the write fails");
    assert!(error.message.contains("could not be written"), "{error:?}");
    assert_eq!(
        std::fs::read(&backup_path).expect("the backup"),
        backup_before,
        "the backup is rolled back"
    );
    assert!(primary_path.is_dir());
    assert!(service.list()[0].enabled, "the mutation is not adopted");

    std::fs::remove_dir(&primary_path).expect("remove the obstacle");
    std::fs::write(&primary_path, &primary_before).expect("restore the primary");
}

#[tokio::test]
async fn a_missing_or_unusable_primary_reads_the_valid_backup() {
    let root = fixture_root("reader-fallback");
    let state = root.join("state");
    let stored = [
        subscription("go", ProviderId::OpenCodeGo, "go-fallback-0001"),
        subscription("or", ProviderId::OpenRouter, "or-fallback-0002"),
    ];
    save_subscriptions(&state, &stored).expect("credentials");

    std::fs::remove_file(credentials_path(&state)).expect("delete the primary");
    let loaded = load_subscriptions(&state);
    assert_eq!(loaded.source, CredentialSource::Backup);
    assert_eq!(loaded.subscriptions, stored);
    assert!(loaded.preserved.is_none());

    std::fs::write(credentials_path(&state), b"{not json").expect("corrupt the primary");
    let loaded = load_subscriptions(&state);
    assert_eq!(loaded.source, CredentialSource::Backup);
    assert_eq!(loaded.subscriptions, stored);
    let preserved = loaded.preserved.expect("the damaged primary is preserved");
    assert!(preserved.exists());
    assert!(
        !credentials_path(&state).exists(),
        "the unusable primary was moved aside"
    );
}

#[tokio::test]
async fn startup_repairs_every_credential_file_direction() {
    let root = fixture_root("startup-repair");
    let state = root.join("state");
    let repo = root.join("repo");
    save_subscriptions(
        &state,
        &[subscription("go", ProviderId::OpenCodeGo, "go-repair-0001")],
    )
    .expect("credentials");
    let primary_path = credentials_path(&state);
    let backup_path = credentials_backup_path(&state);
    let canonical = std::fs::read(&primary_path).expect("the primary");

    // Missing primary, valid backup: restore it and raise one loss.
    std::fs::remove_file(&primary_path).expect("delete the primary");
    let (audit, audits) = collecting_audit();
    let _service = service_with_audit(&state, &repo, Arc::new(Mutex::new(Vec::new())), audit);
    assert_eq!(
        std::fs::read(&primary_path).expect("the repaired primary"),
        canonical
    );
    assert_credentials_pair(&state);
    assert_eq!(loss_count(&audits), 1);
    assert!(!credentials_lost(&state));

    // Valid primary, missing backup: rewrite it quietly.
    std::fs::remove_file(&backup_path).expect("delete the backup");
    let (audit, audits) = collecting_audit();
    let _service = service_with_audit(&state, &repo, Arc::new(Mutex::new(Vec::new())), audit);
    assert_eq!(
        std::fs::read(&backup_path).expect("the repaired backup"),
        canonical
    );
    assert_eq!(loss_count(&audits), 0);
    assert_eq!(activity_count(&audits), 1);

    // Valid primary, unusable backup: preserve it and rewrite quietly.
    std::fs::write(&backup_path, b"{not json").expect("corrupt the backup");
    let (audit, audits) = collecting_audit();
    let _service = service_with_audit(&state, &repo, Arc::new(Mutex::new(Vec::new())), audit);
    assert_eq!(
        std::fs::read(&backup_path).expect("the repaired backup"),
        canonical
    );
    assert_eq!(loss_count(&audits), 0);
    assert_eq!(activity_count(&audits), 1);

    // Unusable primary, valid backup: preserve it, restore from the backup,
    // and raise one loss.
    std::fs::write(&primary_path, b"{not json").expect("corrupt the primary");
    let (audit, audits) = collecting_audit();
    let _service = service_with_audit(&state, &repo, Arc::new(Mutex::new(Vec::new())), audit);
    assert_eq!(
        std::fs::read(&primary_path).expect("the repaired primary"),
        canonical
    );
    assert_credentials_pair(&state);
    assert_eq!(loss_count(&audits), 1);
    let damaged = std::fs::read_dir(state.join("providers"))
        .expect("the providers directory")
        .flatten()
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .contains("credentials.json.damaged-")
        });
    assert!(damaged, "the unusable primary was preserved aside");
}

#[tokio::test]
async fn a_running_refresh_restores_deleted_files_before_publishing() {
    let root = fixture_root("running-repair");
    let state = root.join("state");
    let repo = root.join("repo");
    let (audit, audits) = collecting_audit();
    let service = service_with_audit(&state, &repo, Arc::new(Mutex::new(Vec::new())), audit);
    save(&service, "opencode-go", "main", "sk-running-1234")
        .await
        .expect("the provider saves");
    let primary_path = credentials_path(&state);
    let backup_path = credentials_backup_path(&state);
    let canonical = std::fs::read(&primary_path).expect("the primary");

    std::fs::remove_file(&primary_path).expect("delete the primary");
    service.refresh(false).await;
    assert_eq!(
        std::fs::read(&primary_path).expect("the restored primary"),
        canonical
    );
    assert_credentials_pair(&state);
    assert_eq!(loss_count(&audits), 1);
    assert!(service.view().refusal.is_none());

    // Both files gone in the same tick: the in-memory list restores both.
    std::fs::remove_file(&primary_path).expect("delete the primary");
    std::fs::remove_file(&backup_path).expect("delete the backup");
    service.refresh(false).await;
    assert_eq!(
        std::fs::read(&primary_path).expect("the restored primary"),
        canonical
    );
    assert_eq!(
        std::fs::read(&backup_path).expect("the restored backup"),
        canonical
    );
    assert_eq!(loss_count(&audits), 2, "a later loss alarms again");
}

#[tokio::test]
async fn an_unrecoverable_loss_alarms_once_across_restarts_and_keeps_evidence() {
    let root = fixture_root("loss-dedup");
    let state = root.join("state");
    let repo = root.join("repo");
    let (audit, audits) = collecting_audit();
    let service = service_with_audit(
        &state,
        &repo,
        Arc::new(Mutex::new(Vec::new())),
        audit.clone(),
    );
    save(&service, "opencode-go", "main", "sk-loss-1234")
        .await
        .expect("the provider saves");
    write_selection_snapshot(
        &state,
        ProviderId::OpenCodeGo,
        &service.list()[0].id,
        "main",
        "opencode-go/deepseek-v4.1-flash",
        Some(0.5),
        "2026-11-09T09:56:49.003Z",
    )
    .expect("a selection");
    std::fs::remove_file(credentials_path(&state)).expect("delete the primary");
    std::fs::remove_file(credentials_backup_path(&state)).expect("delete the backup");

    let restarted = service_with_audit(
        &state,
        &repo,
        Arc::new(Mutex::new(Vec::new())),
        audit.clone(),
    );
    assert_eq!(loss_count(&audits), 1, "the first loss alarms once");
    assert!(credentials_lost(&state));
    let message = restarted.view().refusal.expect("a refusal");
    assert_eq!(message, lost_credentials_message(&credentials_path(&state)));
    assert!(message.contains("settings.providers"));
    assert!(!message.contains("No provider is configured"));

    // The same loss survives a second restart and a refresh without another
    // record, frame, or issue.
    let (audit, audits) = collecting_audit();
    let third = service_with_audit(&state, &repo, Arc::new(Mutex::new(Vec::new())), audit);
    third.refresh(false).await;
    assert_eq!(loss_count(&audits), 0, "the same loss alarms once");
    assert!(state.join("providers/selection.json").exists());
    assert!(third.view().selection.is_none());
}

#[tokio::test]
async fn a_backup_only_repair_is_quiet() {
    let root = fixture_root("backup-only");
    let state = root.join("state");
    let repo = root.join("repo");
    save_subscriptions(
        &state,
        &[subscription("go", ProviderId::OpenCodeGo, "go-backup-0001")],
    )
    .expect("credentials");
    let primary_path = credentials_path(&state);
    let backup_path = credentials_backup_path(&state);
    let canonical = std::fs::read(&primary_path).expect("the primary");
    std::fs::remove_file(&backup_path).expect("delete the backup");

    let (audit, audits) = collecting_audit();
    let _service = service_with_audit(&state, &repo, Arc::new(Mutex::new(Vec::new())), audit);
    assert_eq!(std::fs::read(&backup_path).expect("the backup"), canonical);
    assert_eq!(activity_count(&audits), 1);
    assert_eq!(loss_count(&audits), 0);
    assert!(!credentials_lost(&state));
}

#[tokio::test]
async fn one_mutation_recovers_an_unrecoverable_store_without_retyping_keys() {
    let root = fixture_root("operator-recovery");
    let state = root.join("state");
    let repo = root.join("repo");
    let service = service_at(&state, &repo, Arc::new(Mutex::new(Vec::new())));
    save(&service, "opencode-go", "main", "sk-recover-1234")
        .await
        .expect("the provider saves");
    let id = service.list()[0].id.clone();
    std::fs::remove_file(credentials_path(&state)).expect("delete the primary");
    std::fs::remove_file(credentials_backup_path(&state)).expect("delete the backup");

    service.set_enabled(&id, false).expect("the mutation saves");
    assert_credentials_pair(&state);
    assert!(!credentials_lost(&state));
    assert_eq!(service.list()[0].id, id);
    service.set_enabled(&id, true).expect("the mutation saves");

    let environment =
        worker_peer_environment(&state, &repo, HashMap::new(), ProviderOptions::default())
            .await
            .expect("the recovered store resolves");
    assert_eq!(
        environment
            .get("OPENCODE_API_KEY")
            .and_then(|value| value.as_deref()),
        Some("sk-recover-1234")
    );
}

#[tokio::test]
async fn no_key_reaches_the_audit_view_marker_or_selection() {
    let root = fixture_root("no-leak");
    let state = root.join("state");
    let repo = root.join("repo");
    let key = "sk-secret-98765432";
    let (audit, audits) = collecting_audit();
    let service = service_with_audit(&state, &repo, Arc::new(Mutex::new(Vec::new())), audit);
    save(&service, "opencode-go", "main", key)
        .await
        .expect("the provider saves");
    std::fs::remove_file(credentials_path(&state)).expect("delete the primary");
    service.refresh(false).await;

    let audit_text = format!("{:?}", *audits.lock().expect("audits"));
    assert!(!audit_text.contains(key), "{audit_text}");
    let frame = devboard::jsjson::stringify(&service.state_frame());
    assert!(!frame.contains(key), "{frame}");
    let marker = std::fs::read_to_string(credentials_marker_path(&state)).expect("the marker");
    assert!(!marker.contains(key), "{marker}");
    let selection =
        std::fs::read_to_string(state.join("providers/selection.json")).expect("the selection");
    assert!(!selection.contains(key), "{selection}");
    assert_eq!(service.view().subscriptions[0].masked_key, "••••5432");
}

#[tokio::test]
async fn a_worker_retries_a_lost_store_then_succeeds_or_refuses() {
    use std::sync::atomic::AtomicUsize;

    let root = fixture_root("worker-retry");
    let state = root.join("state");
    let repo = root.join("repo");
    save_subscriptions(
        &state,
        &[subscription("go", ProviderId::OpenCodeGo, "go-retry-0001")],
    )
    .expect("credentials");
    let primary_path = credentials_path(&state);
    let backup_path = credentials_backup_path(&state);
    let primary_bytes = std::fs::read(&primary_path).expect("the primary");
    let backup_bytes = std::fs::read(&backup_path).expect("the backup");

    let restored = Arc::new(AtomicBool::new(false));
    let sleeps = Arc::new(AtomicUsize::new(0));
    let sleep: devboard::providers::RetrySleep = {
        let restored = Arc::clone(&restored);
        let sleeps = Arc::clone(&sleeps);
        let primary_path = primary_path.clone();
        let backup_path = backup_path.clone();
        let primary_bytes = primary_bytes.clone();
        let backup_bytes = backup_bytes.clone();
        Arc::new(move |_milliseconds: u64| {
            sleeps.fetch_add(1, Ordering::SeqCst);
            if !restored.swap(true, Ordering::SeqCst) {
                std::fs::write(&primary_path, &primary_bytes).expect("restore the primary");
                std::fs::write(&backup_path, &backup_bytes).expect("restore the backup");
            }
            Box::pin(async {})
        })
    };
    let options = ProviderOptions {
        retry_sleep: Some(sleep),
        ..ProviderOptions::default()
    };
    let environment = devboard::providers::create_worker_provider_environment(
        &state,
        &repo,
        HashMap::new(),
        options,
    );
    let first = environment.resolve().await.expect("the first resolve");
    assert_eq!(
        first
            .get("OPENCODE_API_KEY")
            .and_then(|value| value.as_deref()),
        Some("go-retry-0001")
    );

    // A file that reappears inside the retry window resolves successfully.
    std::fs::remove_file(&primary_path).expect("delete the primary");
    std::fs::remove_file(&backup_path).expect("delete the backup");
    let recovered = environment.resolve().await.expect("the retried resolve");
    assert_eq!(
        recovered
            .get("OPENCODE_API_KEY")
            .and_then(|value| value.as_deref()),
        Some("go-retry-0001")
    );
    assert!(sleeps.load(Ordering::SeqCst) >= 1);

    // A store that never returns refuses with the precise lost-credentials
    // message after the bounded window.
    std::fs::remove_file(&primary_path).expect("delete the primary");
    std::fs::remove_file(&backup_path).expect("delete the backup");
    let error = environment
        .resolve()
        .await
        .expect_err("the store stays lost");
    assert!(error.message.contains(&primary_path.display().to_string()));
    assert!(error.message.contains("settings.providers"));
    assert!(!error.message.contains("No provider is configured"));
    assert!(
        devboard::providers::WORKER_PROVIDER_RETRY_DELAYS_MS
            .iter()
            .sum::<u64>()
            <= 5_000
    );
    assert!(
        devboard::providers::WORKER_PROVIDER_RETRY_DELAYS_MS.len() >= 2,
        "at least two attempts"
    );
}

#[tokio::test]
async fn a_loss_writes_one_server_error_one_frame_and_one_gitea_issue() {
    use axum::{extract::Json, routing::post, Router};

    let root = fixture_root("loss-alarm");
    let repo = root.join("repo");
    let state = root.join("state");
    std::fs::create_dir_all(repo.join(".devboard")).expect("a harness directory");
    let key = "sk-alarm-13572468";
    save_subscriptions(&state, &[subscription("go", ProviderId::OpenCodeGo, key)])
        .expect("credentials");

    let calls: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("a stub listener");
    let base = format!("http://{}", listener.local_addr().expect("an address"));
    let route_calls = Arc::clone(&calls);
    let server = tokio::spawn(async move {
        let app = Router::new().route(
            "/api/v1/repos/acme/repo/issues",
            post(move |Json(body): Json<Value>| {
                let calls = Arc::clone(&route_calls);
                async move {
                    calls.lock().expect("calls").push(body.clone());
                    Json(json!({
                        "number": 41,
                        "title": body.get("title").cloned().unwrap_or(Value::Null),
                        "html_url": "https://gitea.test/acme/repo/issues/41",
                    }))
                }
            }),
        );
        let _ = axum::serve(listener, app).await;
    });

    let config = Config {
        hostname: "127.0.0.1".to_string(),
        port: 0,
        adrs_dir: repo.join("adrs"),
        repo_dir: repo.clone(),
        goal_file: repo.join("GOAL.md"),
        static_dir: None,
        agent_command: "true".to_string(),
        state_dir: state.clone(),
        allowed_hosts: Vec::new(),
        feedback: Some(devboard::config::FeedbackConfig {
            base_url: base,
            repo: "acme/repo".to_string(),
            token: None,
            timeout_ms: 5_000,
        }),
    };
    let journal = Journal::open(&config.state_dir, &config.repo_dir, 0);
    let app = App::new(config, journal);
    let (conn, mut inbox) = connection();
    app.register(conn.clone()).await;

    let primary_path = credentials_path(&state);
    std::fs::remove_file(&primary_path).expect("delete the primary");
    std::fs::remove_file(credentials_backup_path(&state)).expect("delete the backup");
    app.providers.reconcile_credentials();

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while calls.lock().expect("calls").is_empty() && std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let calls = calls.lock().expect("calls");
    assert_eq!(calls.len(), 1, "exactly one issue is filed");
    let issue = &calls[0];
    let title = issue["title"].as_str().expect("a title");
    let body = issue["body"].as_str().expect("a body");
    assert!(title.contains(&primary_path.display().to_string()));
    assert!(body.contains(&primary_path.display().to_string()));
    assert!(body.contains("settings.providers"));
    assert!(!title.contains(key) && !body.contains(key));

    let frames: Vec<Value> = all_frames(&mut inbox)
        .iter()
        .filter_map(|frame| serde_json::from_str::<Value>(frame).ok())
        .filter(|frame| frame["type"] == "error")
        .collect();
    assert_eq!(frames.len(), 1, "exactly one error frame: {frames:?}");
    let message = frames[0]["message"].as_str().expect("a message");
    assert!(message.contains(&primary_path.display().to_string()));
    assert!(!message.contains(key));

    let journal_text = std::fs::read_to_string(devboard::journal::journal_file(&state, &repo))
        .expect("the journal");
    let errors: Vec<Value> = journal_text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|record| record["kind"] == "server-error")
        .collect();
    assert_eq!(errors.len(), 1, "exactly one server-error record");
    let text = errors[0]["text"].as_str().expect("the record text");
    assert!(text.contains(&primary_path.display().to_string()));
    assert!(!text.contains(key));

    server.abort();
}
