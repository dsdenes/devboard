//! The `/ws` client command protocol.
//!
//! Every command name the TypeScript dispatcher accepts is one variant. A
//! field the client may omit stays an optional JSON value so a handler can
//! refuse it with the same message the TypeScript server writes; the parser
//! itself only rejects an unknown command name, exactly like
//! `parseClientMessage`.

use serde_json::Value;

/// Every dispatcher command name, in the order the protocol lists them.
pub const COMMAND_NAMES: &[&str] = &[
    "listRecords",
    "getGoal",
    "getProject",
    "getVersion",
    "getMcpTools",
    "getInstalledSkills",
    "setInstalledSkillEnabled",
    "getIssues",
    "getIssuesRun",
    "startIssues",
    "pauseIssues",
    "resumeIssues",
    "stopIssues",
    "checkIssues",
    "answerIssues",
    "closeIssue",
    "getGoalDrafts",
    "getGoalDraft",
    "startGoalDraft",
    "stopGoalDraft",
    "deleteGoalDraft",
    "answerGoalDraft",
    "getAgents",
    "getAgent",
    "refreshAgent",
    "startAgent",
    "stopAgent",
    "setAgentSettings",
    "disableAgentTimer",
    "getAgentPrompt",
    "restartServer",
    "startRun",
    "startLifecycle",
    "stopLifecycle",
    "pauseLifecycle",
    "resumeLifecycle",
    "reviseGoal",
    "createGoal",
    "prepareSkills",
    "getSkills",
    "deleteSkill",
    "resetImplementation",
    "createFlowGoal",
    "cancelFlowGoal",
    "startFlowImplementation",
    "stopFlowImplementation",
    "retryFlowPr",
    "markFlowPrReady",
    "mergeFlowPr",
    "sendFlowSteering",
    "acceptFlowWidget",
    "refuseFlowWidget",
    "openFlowWidget",
    "closeFlowWidget",
    "sendFlowConversation",
    "sendFlowConclusion",
    "dismissFlowBlocker",
    "flowAnswer",
    "answer",
    "discoverProject",
    "discoverAgent",
    "discoverRemote",
    "switchDiscoverRemote",
    "removeDiscoverRemote",
    "clearDiscoverRemote",
    "stopDiscover",
    "answerDiscover",
    "getDiscover",
    "confirmGlossaryTerm",
    "rejectGlossaryTerm",
    "ask",
    "closeAsk",
    "getProviders",
    "saveProvider",
    "deleteProvider",
    "setProviderEnabled",
    "refreshProviders",
];

/// One command a client may send over the dashboard socket.
#[derive(Debug, Clone)]
pub enum Command {
    ListRecords,
    GetGoal,
    GetProject,
    GetVersion,
    GetMcpTools,
    GetInstalledSkills,
    SetInstalledSkillEnabled {
        name: Option<Value>,
        enabled: Option<Value>,
    },
    GetIssues,
    GetIssuesRun {
        run_id: Option<Value>,
    },
    StartIssues,
    PauseIssues,
    ResumeIssues,
    StopIssues,
    CheckIssues,
    AnswerIssues {
        id: Option<Value>,
        value: Option<Value>,
        run_id: Option<Value>,
    },
    CloseIssue {
        number: Option<Value>,
    },
    GetGoalDrafts,
    GetGoalDraft {
        path: Option<Value>,
    },
    StartGoalDraft {
        path: Option<Value>,
    },
    StopGoalDraft {
        path: Option<Value>,
    },
    DeleteGoalDraft {
        path: Option<Value>,
    },
    AnswerGoalDraft {
        path: Option<Value>,
        id: Option<Value>,
        value: Option<Value>,
    },
    GetAgents,
    GetAgent {
        id: Option<Value>,
    },
    RefreshAgent {
        id: Option<Value>,
    },
    StartAgent {
        id: Option<Value>,
    },
    StopAgent {
        id: Option<Value>,
    },
    SetAgentSettings {
        id: Option<Value>,
        minutes: Option<Value>,
        max_per_hour: Option<Value>,
        max_pending: Option<Value>,
    },
    DisableAgentTimer {
        id: Option<Value>,
    },
    GetAgentPrompt {
        id: Option<Value>,
    },
    RestartServer {
        when_idle: Option<Value>,
    },
    StartRun {
        file: Option<Value>,
    },
    StartLifecycle,
    StopLifecycle,
    PauseLifecycle,
    ResumeLifecycle,
    ReviseGoal {
        request: Option<Value>,
    },
    CreateGoal,
    PrepareSkills,
    GetSkills,
    DeleteSkill {
        name: Option<Value>,
    },
    ResetImplementation,
    CreateFlowGoal,
    CancelFlowGoal,
    StartFlowImplementation,
    StopFlowImplementation,
    RetryFlowPr,
    MarkFlowPrReady,
    MergeFlowPr,
    SendFlowSteering {
        text: Option<Value>,
    },
    AcceptFlowWidget {
        id: Option<Value>,
        accepted: Option<Value>,
    },
    RefuseFlowWidget {
        id: Option<Value>,
        reason: Option<Value>,
    },
    OpenFlowWidget {
        id: Option<Value>,
    },
    CloseFlowWidget,
    SendFlowConversation {
        text: Option<Value>,
    },
    SendFlowConclusion {
        text: Option<Value>,
    },
    DismissFlowBlocker {
        id: Option<Value>,
    },
    FlowAnswer {
        id: Option<Value>,
        value: Option<Value>,
        target: Option<Value>,
    },
    Answer {
        id: Option<Value>,
        value: Option<Value>,
        lane: Option<Value>,
    },
    DiscoverProject,
    DiscoverAgent {
        agent: Option<Value>,
    },
    DiscoverRemote {
        url: String,
    },
    SwitchDiscoverRemote {
        url: String,
    },
    RemoveDiscoverRemote {
        url: String,
    },
    ClearDiscoverRemote,
    StopDiscover,
    AnswerDiscover {
        id: Option<Value>,
        value: Option<Value>,
    },
    GetDiscover,
    ConfirmGlossaryTerm {
        context: Option<Value>,
        id: Option<Value>,
    },
    RejectGlossaryTerm {
        context: Option<Value>,
        id: Option<Value>,
        reason: Option<Value>,
    },
    Ask {
        conversation_id: Option<Value>,
        question: Option<Value>,
        context: Option<Value>,
    },
    CloseAsk {
        conversation_id: Option<Value>,
    },
    GetProviders,
    SaveProvider {
        request_id: Option<Value>,
        id: Option<Value>,
        provider: Option<Value>,
        label: Option<Value>,
        key: Option<Value>,
    },
    DeleteProvider {
        request_id: Option<Value>,
        id: Option<Value>,
    },
    SetProviderEnabled {
        request_id: Option<Value>,
        id: Option<Value>,
        enabled: Option<Value>,
    },
    RefreshProviders,
}

impl Command {
    /// The corpus command name this variant carries.
    pub fn name(&self) -> &'static str {
        match self {
            Self::ListRecords => "listRecords",
            Self::GetGoal => "getGoal",
            Self::GetProject => "getProject",
            Self::GetVersion => "getVersion",
            Self::GetMcpTools => "getMcpTools",
            Self::GetInstalledSkills => "getInstalledSkills",
            Self::SetInstalledSkillEnabled { .. } => "setInstalledSkillEnabled",
            Self::GetIssues => "getIssues",
            Self::GetIssuesRun { .. } => "getIssuesRun",
            Self::StartIssues => "startIssues",
            Self::PauseIssues => "pauseIssues",
            Self::ResumeIssues => "resumeIssues",
            Self::StopIssues => "stopIssues",
            Self::CheckIssues => "checkIssues",
            Self::AnswerIssues { .. } => "answerIssues",
            Self::CloseIssue { .. } => "closeIssue",
            Self::GetGoalDrafts => "getGoalDrafts",
            Self::GetGoalDraft { .. } => "getGoalDraft",
            Self::StartGoalDraft { .. } => "startGoalDraft",
            Self::StopGoalDraft { .. } => "stopGoalDraft",
            Self::DeleteGoalDraft { .. } => "deleteGoalDraft",
            Self::AnswerGoalDraft { .. } => "answerGoalDraft",
            Self::GetAgents => "getAgents",
            Self::GetAgent { .. } => "getAgent",
            Self::RefreshAgent { .. } => "refreshAgent",
            Self::StartAgent { .. } => "startAgent",
            Self::StopAgent { .. } => "stopAgent",
            Self::SetAgentSettings { .. } => "setAgentSettings",
            Self::DisableAgentTimer { .. } => "disableAgentTimer",
            Self::GetAgentPrompt { .. } => "getAgentPrompt",
            Self::RestartServer { .. } => "restartServer",
            Self::StartRun { .. } => "startRun",
            Self::StartLifecycle => "startLifecycle",
            Self::StopLifecycle => "stopLifecycle",
            Self::PauseLifecycle => "pauseLifecycle",
            Self::ResumeLifecycle => "resumeLifecycle",
            Self::ReviseGoal { .. } => "reviseGoal",
            Self::CreateGoal => "createGoal",
            Self::PrepareSkills => "prepareSkills",
            Self::GetSkills => "getSkills",
            Self::DeleteSkill { .. } => "deleteSkill",
            Self::ResetImplementation => "resetImplementation",
            Self::CreateFlowGoal => "createFlowGoal",
            Self::CancelFlowGoal => "cancelFlowGoal",
            Self::StartFlowImplementation => "startFlowImplementation",
            Self::StopFlowImplementation => "stopFlowImplementation",
            Self::RetryFlowPr => "retryFlowPr",
            Self::MarkFlowPrReady => "markFlowPrReady",
            Self::MergeFlowPr => "mergeFlowPr",
            Self::SendFlowSteering { .. } => "sendFlowSteering",
            Self::AcceptFlowWidget { .. } => "acceptFlowWidget",
            Self::RefuseFlowWidget { .. } => "refuseFlowWidget",
            Self::OpenFlowWidget { .. } => "openFlowWidget",
            Self::CloseFlowWidget => "closeFlowWidget",
            Self::SendFlowConversation { .. } => "sendFlowConversation",
            Self::SendFlowConclusion { .. } => "sendFlowConclusion",
            Self::DismissFlowBlocker { .. } => "dismissFlowBlocker",
            Self::FlowAnswer { .. } => "flowAnswer",
            Self::Answer { .. } => "answer",
            Self::DiscoverProject => "discoverProject",
            Self::DiscoverAgent { .. } => "discoverAgent",
            Self::DiscoverRemote { .. } => "discoverRemote",
            Self::SwitchDiscoverRemote { .. } => "switchDiscoverRemote",
            Self::RemoveDiscoverRemote { .. } => "removeDiscoverRemote",
            Self::ClearDiscoverRemote => "clearDiscoverRemote",
            Self::StopDiscover => "stopDiscover",
            Self::AnswerDiscover { .. } => "answerDiscover",
            Self::GetDiscover => "getDiscover",
            Self::ConfirmGlossaryTerm { .. } => "confirmGlossaryTerm",
            Self::RejectGlossaryTerm { .. } => "rejectGlossaryTerm",
            Self::Ask { .. } => "ask",
            Self::CloseAsk { .. } => "closeAsk",
            Self::GetProviders => "getProviders",
            Self::SaveProvider { .. } => "saveProvider",
            Self::DeleteProvider { .. } => "deleteProvider",
            Self::SetProviderEnabled { .. } => "setProviderEnabled",
            Self::RefreshProviders => "refreshProviders",
        }
    }

    /// Whether a reset in progress lets this command answer.
    pub fn is_read_only(&self) -> bool {
        matches!(
            self,
            Self::ListRecords
                | Self::GetGoal
                | Self::GetProject
                | Self::GetVersion
                | Self::GetMcpTools
                | Self::GetInstalledSkills
                | Self::GetIssues
                | Self::GetIssuesRun { .. }
                | Self::GetGoalDrafts
                | Self::GetGoalDraft { .. }
                | Self::GetAgents
                | Self::GetAgent { .. }
                | Self::RefreshAgent { .. }
                | Self::GetAgentPrompt { .. }
                | Self::GetSkills
                | Self::GetDiscover
                | Self::GetProviders
        )
    }
}

/// Parses one client frame's JSON text into a command.
///
/// A frame that is not JSON, not an object, has no string `type`, or names no
/// command yields `None`; the socket answers with the invalid-message error.
pub fn parse_client_message(text: &str) -> Option<Command> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    let kind = object.get("type")?.as_str()?;
    let field = |name: &str| object.get(name).cloned();
    Some(match kind {
        "listRecords" => Command::ListRecords,
        "getGoal" => Command::GetGoal,
        "getProject" => Command::GetProject,
        "getVersion" => Command::GetVersion,
        "getMcpTools" => Command::GetMcpTools,
        "getInstalledSkills" => Command::GetInstalledSkills,
        "setInstalledSkillEnabled" => Command::SetInstalledSkillEnabled {
            name: field("name"),
            enabled: field("enabled"),
        },
        "getIssues" => Command::GetIssues,
        "getIssuesRun" => Command::GetIssuesRun {
            run_id: field("runId"),
        },
        "startIssues" => Command::StartIssues,
        "pauseIssues" => Command::PauseIssues,
        "resumeIssues" => Command::ResumeIssues,
        "stopIssues" => Command::StopIssues,
        "checkIssues" => Command::CheckIssues,
        "answerIssues" => Command::AnswerIssues {
            id: field("id"),
            value: field("value"),
            run_id: field("runId"),
        },
        "closeIssue" => Command::CloseIssue {
            number: field("number"),
        },
        "getGoalDrafts" => Command::GetGoalDrafts,
        "getGoalDraft" => Command::GetGoalDraft {
            path: field("path"),
        },
        "startGoalDraft" => Command::StartGoalDraft {
            path: field("path"),
        },
        "stopGoalDraft" => Command::StopGoalDraft {
            path: field("path"),
        },
        "deleteGoalDraft" => Command::DeleteGoalDraft {
            path: field("path"),
        },
        "answerGoalDraft" => Command::AnswerGoalDraft {
            path: field("path"),
            id: field("id"),
            value: field("value"),
        },
        "getAgents" => Command::GetAgents,
        "getAgent" => Command::GetAgent { id: field("id") },
        "refreshAgent" => Command::RefreshAgent { id: field("id") },
        "startAgent" => Command::StartAgent { id: field("id") },
        "stopAgent" => Command::StopAgent { id: field("id") },
        "setAgentSettings" => Command::SetAgentSettings {
            id: field("id"),
            minutes: field("minutes"),
            max_per_hour: field("maxPerHour"),
            max_pending: field("maxPending"),
        },
        "disableAgentTimer" => Command::DisableAgentTimer { id: field("id") },
        "getAgentPrompt" => Command::GetAgentPrompt { id: field("id") },
        "restartServer" => Command::RestartServer {
            when_idle: field("whenIdle"),
        },
        "startRun" => Command::StartRun {
            file: field("file"),
        },
        "startLifecycle" => Command::StartLifecycle,
        "stopLifecycle" => Command::StopLifecycle,
        "pauseLifecycle" => Command::PauseLifecycle,
        "resumeLifecycle" => Command::ResumeLifecycle,
        "reviseGoal" => Command::ReviseGoal {
            request: field("request"),
        },
        "createGoal" => Command::CreateGoal,
        "prepareSkills" => Command::PrepareSkills,
        "getSkills" => Command::GetSkills,
        "deleteSkill" => Command::DeleteSkill {
            name: field("name"),
        },
        "resetImplementation" => Command::ResetImplementation,
        "createFlowGoal" => Command::CreateFlowGoal,
        "cancelFlowGoal" => Command::CancelFlowGoal,
        "startFlowImplementation" => Command::StartFlowImplementation,
        "stopFlowImplementation" => Command::StopFlowImplementation,
        "retryFlowPr" => Command::RetryFlowPr,
        "markFlowPrReady" => Command::MarkFlowPrReady,
        "mergeFlowPr" => Command::MergeFlowPr,
        "sendFlowSteering" => Command::SendFlowSteering {
            text: field("text"),
        },
        "acceptFlowWidget" => Command::AcceptFlowWidget {
            id: field("id"),
            accepted: field("accepted"),
        },
        "refuseFlowWidget" => Command::RefuseFlowWidget {
            id: field("id"),
            reason: field("reason"),
        },
        "openFlowWidget" => Command::OpenFlowWidget { id: field("id") },
        "closeFlowWidget" => Command::CloseFlowWidget,
        "sendFlowConversation" => Command::SendFlowConversation {
            text: field("text"),
        },
        "sendFlowConclusion" => Command::SendFlowConclusion {
            text: field("text"),
        },
        "dismissFlowBlocker" => Command::DismissFlowBlocker { id: field("id") },
        "flowAnswer" => Command::FlowAnswer {
            id: field("id"),
            value: field("value"),
            target: field("target"),
        },
        "answer" => Command::Answer {
            id: field("id"),
            value: field("value"),
            lane: field("lane"),
        },
        "discoverProject" => Command::DiscoverProject,
        "discoverAgent" => Command::DiscoverAgent {
            agent: field("agent"),
        },
        "discoverRemote" => Command::DiscoverRemote {
            url: object.get("url")?.as_str()?.to_string(),
        },
        "switchDiscoverRemote" => Command::SwitchDiscoverRemote {
            url: object.get("url")?.as_str()?.to_string(),
        },
        "removeDiscoverRemote" => Command::RemoveDiscoverRemote {
            url: object.get("url")?.as_str()?.to_string(),
        },
        "clearDiscoverRemote" => Command::ClearDiscoverRemote,
        "stopDiscover" => Command::StopDiscover,
        "answerDiscover" => Command::AnswerDiscover {
            id: field("id"),
            value: field("value"),
        },
        "getDiscover" => Command::GetDiscover,
        "confirmGlossaryTerm" => Command::ConfirmGlossaryTerm {
            context: field("context"),
            id: field("id"),
        },
        "rejectGlossaryTerm" => Command::RejectGlossaryTerm {
            context: field("context"),
            id: field("id"),
            reason: field("reason"),
        },
        "ask" => Command::Ask {
            conversation_id: field("conversationId"),
            question: field("question"),
            context: field("context"),
        },
        "closeAsk" => Command::CloseAsk {
            conversation_id: field("conversationId"),
        },
        "getProviders" => Command::GetProviders,
        "saveProvider" => Command::SaveProvider {
            request_id: field("requestId"),
            id: field("id"),
            provider: field("provider"),
            label: field("label"),
            key: field("key"),
        },
        "deleteProvider" => Command::DeleteProvider {
            request_id: field("requestId"),
            id: field("id"),
        },
        "setProviderEnabled" => Command::SetProviderEnabled {
            request_id: field("requestId"),
            id: field("id"),
            enabled: field("enabled"),
        },
        "refreshProviders" => Command::RefreshProviders,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_name_parses() {
        for name in COMMAND_NAMES {
            let name = *name;
            let frame = if name.starts_with("discoverRemote")
                || name.starts_with("switchDiscoverRemote")
                || name.starts_with("removeDiscoverRemote")
            {
                format!("{{\"type\":\"{name}\",\"url\":\"https://example.test/a\"}}")
            } else {
                format!("{{\"type\":\"{name}\"}}")
            };
            let command = parse_client_message(&frame).unwrap_or_else(|| panic!("{name} parses"));
            assert_eq!(command.name(), name);
        }
    }

    #[test]
    fn unknown_and_malformed_frames_are_refused() {
        for frame in [
            "{}",
            "[]",
            "null",
            "not json",
            "{\"type\":1}",
            "{\"type\":\"nope\"}",
        ] {
            assert!(parse_client_message(frame).is_none(), "{frame}");
        }
        assert!(parse_client_message("{\"type\":\"discoverRemote\"}").is_none());
    }
}
