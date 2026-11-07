//! The Devboard harness.

// The port mirrors callback-heavy TypeScript signatures and durable shapes;
// naming every composed callback type would add aliases without a reader.
#![allow(clippy::type_complexity)]
#![allow(clippy::too_many_arguments)]

pub mod acp;
pub mod acp_stub;
pub mod activity;
pub mod agent_sessions;
pub mod agents_mode;
pub mod app;
pub mod ask_mode;
pub mod assets;
pub mod bench;
pub mod cli_install;
pub mod commit_gate;
pub mod complexity;
pub mod config;
pub mod deadline;
pub mod detached_run;
pub mod discover_mode;
pub mod feedback;
pub mod flow_mode;
pub mod forge;
pub mod forge_auth;
pub mod git;
pub mod gitea;
pub mod goal;
pub mod goal_authoring;
pub mod goal_drafts;
pub mod goal_proposal;
pub mod goal_run;
pub mod http;
pub mod idempotency;
pub mod installed_skills;
pub mod instances;
pub mod issues_mode;
pub mod journal;
pub mod jsjson;
pub mod mcp;
pub mod mcp_server;
pub mod protocol;
pub mod providers;
pub mod publish;
pub mod records;
pub mod redact;
pub mod relaunch;
pub mod release;
pub mod release_suite;
pub mod resources;
pub mod runtime_boundary;
pub mod source_refresh;
pub mod state;
pub mod supervision;
pub mod text_budget;
pub mod ui_preflight;
pub mod updates;
pub mod version;
pub mod workers;
