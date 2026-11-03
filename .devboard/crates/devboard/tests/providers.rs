//! Provider credentials, masked views, and the five provider wire commands.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use devboard::app::Conn;
use devboard::protocol::Command;
use devboard::providers::{
    load_subscriptions, save_subscriptions, ProviderId, ProviderOptions, ProviderService,
    SaveProviderInput, StoredSubscription, Transport, TransportError, TransportFuture,
    UsageResponse, UsageStatus, PROVIDER_CHANGE_NEEDS_ID,
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
        Err("That subscription no longer exists.".to_string())
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
        Err("That subscription no longer exists.".to_string())
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
