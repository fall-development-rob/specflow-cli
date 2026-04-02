use napi_derive::napi;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

// ── YAML schema structs ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ContractFile {
    contract_meta: ContractMeta,
    #[serde(default)]
    llm_policy: Option<LlmPolicy>,
    #[serde(default)]
    rules: Option<Rules>,
    #[serde(default)]
    compliance_checklist: Option<serde_yaml::Value>,
    #[serde(default)]
    test_hooks: Option<serde_yaml::Value>,
    #[serde(default)]
    defaults: Option<serde_yaml::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ContractMeta {
    id: String,
    #[serde(default)]
    version: Option<serde_yaml::Value>,
    #[serde(default)]
    created_from_spec: Option<String>,
    #[serde(default)]
    covers_reqs: Vec<String>,
    #[serde(default)]
    owner: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LlmPolicy {
    #[serde(default)]
    enforce: Option<bool>,
    #[serde(default)]
    llm_may_modify_non_negotiables: Option<bool>,
    #[serde(default)]
    override_phrase: Option<String>,
    #[serde(default)]
    severity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Rules {
    #[serde(default)]
    non_negotiable: Vec<Rule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Rule {
    id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    scope: Vec<String>,
    #[serde(default)]
    behavior: Option<RuleBehavior>,
    #[serde(default)]
    example_violation: Option<String>,
    #[serde(default)]
    example_compliant: Option<String>,
    #[serde(default)]
    enabled_by_default: Option<bool>,
    #[serde(default)]
    configurable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RuleBehavior {
    #[serde(default)]
    forbidden_patterns: Vec<PatternEntry>,
    #[serde(default)]
    required_patterns: Vec<PatternEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PatternEntry {
    pattern: serde_yaml::Value,
    message: String,
}

// ── Compiled contract structs ───────────────────────────────────────────────

#[derive(Debug, Clone)]
struct CompiledContract {
    meta: ContractMeta,
    source_file: PathBuf,
    rules: Vec<CompiledRule>,
}

#[derive(Debug, Clone)]
struct CompiledRule {
    id: String,
    title: String,
    scope: Vec<String>,
    forbidden: Vec<CompiledPattern>,
    required: Vec<CompiledPattern>,
}

#[derive(Debug, Clone)]
struct CompiledPattern {
    regex: Regex,
    message: String,
    raw: String,
}

// ── NAPI-exposed result types ───────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize)]
pub struct NapiContract {
    pub id: String,
    pub source_file: String,
    pub covers_reqs: Vec<String>,
    pub rules: Vec<NapiRule>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize)]
pub struct NapiRule {
    pub id: String,
    pub title: String,
    pub scope: Vec<String>,
    pub forbidden_count: u32,
    pub required_count: u32,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize)]
pub struct NapiViolation {
    pub contract_id: String,
    pub rule_id: String,
    pub rule_title: String,
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub matched_text: String,
    pub message: String,
    pub pattern: String,
    pub kind: String,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize)]
pub struct NapiScanResult {
    pub violations: Vec<NapiViolation>,
    pub files_scanned: u32,
    pub contracts_loaded: u32,
    pub rules_checked: u32,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize)]
pub struct NapiValidationResult {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub rules_found: u32,
    pub patterns_compiled: u32,
}

// ── Pattern parsing ─────────────────────────────────────────────────────────

fn parse_yaml_pattern(pattern_val: &serde_yaml::Value) -> Result<(Regex, String), String> {
    let pattern_str = match pattern_val {
        serde_yaml::Value::String(s) => s.clone(),
        other => serde_yaml::to_string(other).unwrap_or_default().trim().to_string(),
    };

    let trimmed = pattern_str.trim();
    let re = Regex::new(r"^/(.+)/([gimsuy]*)$").unwrap();

    if let Some(caps) = re.captures(trimmed) {
        let body = &caps[1];
        let flags = &caps[2];

        let mut rust_pattern = String::new();
        if flags.contains('i') {
            rust_pattern.push_str("(?i)");
        }
        if flags.contains('s') {
            rust_pattern.push_str("(?s)");
        }
        if flags.contains('m') {
            rust_pattern.push_str("(?m)");
        }
        rust_pattern.push_str(body);

        let compiled = Regex::new(&rust_pattern)
            .map_err(|e| format!("Failed to compile regex pattern: {}: {}", trimmed, e))?;
        return Ok((compiled, trimmed.to_string()));
    }

    let compiled = Regex::new(trimmed)
        .map_err(|e| format!("Failed to compile regex pattern: {}: {}", trimmed, e))?;
    Ok((compiled, trimmed.to_string()))
}

// ── Contract loading ────────────────────────────────────────────────────────

fn load_contract_internal(path: &Path) -> Result<CompiledContract, String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

    let contract_file: ContractFile = serde_yaml::from_str(&content)
        .map_err(|e| format!("Failed to parse YAML in {}: {}", path.display(), e))?;

    let rules = if let Some(rules) = &contract_file.rules {
        rules
            .non_negotiable
            .iter()
            .map(|rule| {
                let behavior = rule.behavior.as_ref();

                let forbidden = behavior
                    .map(|b| {
                        b.forbidden_patterns
                            .iter()
                            .map(|p| {
                                let (regex, raw) = parse_yaml_pattern(&p.pattern)?;
                                Ok(CompiledPattern {
                                    regex,
                                    message: p.message.clone(),
                                    raw,
                                })
                            })
                            .collect::<Result<Vec<_>, String>>()
                    })
                    .transpose()?
                    .unwrap_or_default();

                let required = behavior
                    .map(|b| {
                        b.required_patterns
                            .iter()
                            .map(|p| {
                                let (regex, raw) = parse_yaml_pattern(&p.pattern)?;
                                Ok(CompiledPattern {
                                    regex,
                                    message: p.message.clone(),
                                    raw,
                                })
                            })
                            .collect::<Result<Vec<_>, String>>()
                    })
                    .transpose()?
                    .unwrap_or_default();

                Ok(CompiledRule {
                    id: rule.id.clone(),
                    title: rule.title.clone().unwrap_or_default(),
                    scope: rule.scope.clone(),
                    forbidden,
                    required,
                })
            })
            .collect::<Result<Vec<_>, String>>()?
    } else {
        vec![]
    };

    Ok(CompiledContract {
        meta: contract_file.contract_meta,
        source_file: path.to_path_buf(),
        rules,
    })
}

fn load_contracts_from_dir_internal(dir: &Path) -> Result<Vec<CompiledContract>, String> {
    if !dir.exists() {
        return Err(format!("Contract directory does not exist: {}", dir.display()));
    }

    let mut contracts = Vec::new();

    for ext in &["yml", "yaml"] {
        let pattern = dir.join(format!("*.{}", ext));
        let pattern_str = pattern.to_string_lossy();

        if let Ok(paths) = glob::glob(&pattern_str) {
            for entry in paths.flatten() {
                match load_contract_internal(&entry) {
                    Ok(c) => contracts.push(c),
                    Err(e) => {
                        eprintln!("Warning: failed to load {}: {}", entry.display(), e);
                    }
                }
            }
        }
    }

    Ok(contracts)
}

// ── Scanning ────────────────────────────────────────────────────────────────

fn resolve_scope_files(project_root: &Path, scope: &[String]) -> Vec<PathBuf> {
    let mut included = Vec::new();
    let mut excluded = Vec::new();

    for pattern in scope {
        if let Some(neg_pattern) = pattern.strip_prefix('!') {
            let full = project_root.join(neg_pattern);
            let full_str = full.to_string_lossy();
            if let Ok(paths) = glob::glob(&full_str) {
                for entry in paths.flatten() {
                    excluded.push(entry);
                }
            }
        } else {
            let full = project_root.join(pattern);
            let full_str = full.to_string_lossy();
            if let Ok(paths) = glob::glob(&full_str) {
                for entry in paths.flatten() {
                    if entry.is_file() {
                        included.push(entry);
                    }
                }
            }
        }
    }

    included.retain(|f| !excluded.contains(f));
    included.sort();
    included.dedup();
    included
}

fn scan_project_internal(
    project_root: &Path,
    contracts: &[CompiledContract],
) -> NapiScanResult {
    let mut all_violations = Vec::new();
    let mut files_scanned = HashSet::new();
    let mut rules_checked: u32 = 0;

    for contract in contracts {
        for rule in &contract.rules {
            rules_checked += 1;
            let files = resolve_scope_files(project_root, &rule.scope);

            for file in &files {
                files_scanned.insert(file.clone());

                let content = match fs::read_to_string(file) {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                // Check forbidden patterns
                for pattern in &rule.forbidden {
                    for (line_idx, line) in content.lines().enumerate() {
                        if let Some(m) = pattern.regex.find(line) {
                            all_violations.push(NapiViolation {
                                contract_id: contract.meta.id.clone(),
                                rule_id: rule.id.clone(),
                                rule_title: rule.title.clone(),
                                file: file.to_string_lossy().to_string(),
                                line: (line_idx + 1) as u32,
                                column: (m.start() + 1) as u32,
                                matched_text: m.as_str().to_string(),
                                message: pattern.message.clone(),
                                pattern: pattern.raw.clone(),
                                kind: "Forbidden".to_string(),
                            });
                        }
                    }
                }

                // Check required patterns
                for pattern in &rule.required {
                    if !pattern.regex.is_match(&content) {
                        all_violations.push(NapiViolation {
                            contract_id: contract.meta.id.clone(),
                            rule_id: rule.id.clone(),
                            rule_title: rule.title.clone(),
                            file: file.to_string_lossy().to_string(),
                            line: 0,
                            column: 0,
                            matched_text: String::new(),
                            message: pattern.message.clone(),
                            pattern: pattern.raw.clone(),
                            kind: "MissingRequired".to_string(),
                        });
                    }
                }
            }
        }
    }

    NapiScanResult {
        violations: all_violations,
        files_scanned: files_scanned.len() as u32,
        contracts_loaded: contracts.len() as u32,
        rules_checked,
    }
}

fn check_snippet_internal(
    contracts: &[CompiledContract],
    code: &str,
    file_path: Option<&str>,
) -> Vec<NapiViolation> {
    let virtual_path = file_path.unwrap_or("inline.ts");
    let mut violations = Vec::new();

    for contract in contracts {
        for rule in &contract.rules {
            let in_scope = rule.scope.is_empty()
                || rule.scope.iter().any(|s| {
                    !s.starts_with('!')
                        && glob::Pattern::new(s)
                            .map(|p| p.matches(virtual_path))
                            .unwrap_or(false)
                });

            if !in_scope {
                continue;
            }

            for pattern in &rule.forbidden {
                for (line_idx, line) in code.lines().enumerate() {
                    if let Some(m) = pattern.regex.find(line) {
                        violations.push(NapiViolation {
                            contract_id: contract.meta.id.clone(),
                            rule_id: rule.id.clone(),
                            rule_title: rule.title.clone(),
                            file: virtual_path.to_string(),
                            line: (line_idx + 1) as u32,
                            column: (m.start() + 1) as u32,
                            matched_text: m.as_str().to_string(),
                            message: pattern.message.clone(),
                            pattern: pattern.raw.clone(),
                            kind: "Forbidden".to_string(),
                        });
                    }
                }
            }

            for pattern in &rule.required {
                if !pattern.regex.is_match(code) {
                    violations.push(NapiViolation {
                        contract_id: contract.meta.id.clone(),
                        rule_id: rule.id.clone(),
                        rule_title: rule.title.clone(),
                        file: virtual_path.to_string(),
                        line: 0,
                        column: 0,
                        matched_text: String::new(),
                        message: pattern.message.clone(),
                        pattern: pattern.raw.clone(),
                        kind: "MissingRequired".to_string(),
                    });
                }
            }
        }
    }

    violations
}

// ── NAPI-exported functions ─────────────────────────────────────────────────

#[napi]
pub fn load_contracts(dir: String) -> napi::Result<Vec<NapiContract>> {
    let dir_path = Path::new(&dir);
    let contracts = load_contracts_from_dir_internal(dir_path)
        .map_err(|e| napi::Error::from_reason(e))?;

    Ok(contracts
        .iter()
        .map(|c| NapiContract {
            id: c.meta.id.clone(),
            source_file: c.source_file.to_string_lossy().to_string(),
            covers_reqs: c.meta.covers_reqs.clone(),
            rules: c.rules.iter().map(|r| NapiRule {
                id: r.id.clone(),
                title: r.title.clone(),
                scope: r.scope.clone(),
                forbidden_count: r.forbidden.len() as u32,
                required_count: r.required.len() as u32,
            }).collect(),
        })
        .collect())
}

#[napi]
pub fn scan_files(contracts_dir: String, target_dir: String) -> napi::Result<NapiScanResult> {
    let dir_path = Path::new(&contracts_dir);
    let target_path = Path::new(&target_dir);

    let contracts = load_contracts_from_dir_internal(dir_path)
        .map_err(|e| napi::Error::from_reason(e))?;

    Ok(scan_project_internal(target_path, &contracts))
}

#[napi]
pub fn check_snippet(
    contracts_dir: String,
    code: String,
    file_path: Option<String>,
) -> napi::Result<Vec<NapiViolation>> {
    let dir_path = Path::new(&contracts_dir);
    let contracts = load_contracts_from_dir_internal(dir_path)
        .map_err(|e| napi::Error::from_reason(e))?;

    Ok(check_snippet_internal(
        &contracts,
        &code,
        file_path.as_deref(),
    ))
}

#[napi]
pub fn validate_contract(file_path: String) -> napi::Result<NapiValidationResult> {
    let path = Path::new(&file_path);

    if !path.exists() {
        return Ok(NapiValidationResult {
            valid: false,
            errors: vec![format!("File not found: {}", file_path)],
            warnings: vec![],
            rules_found: 0,
            patterns_compiled: 0,
        });
    }

    match load_contract_internal(path) {
        Ok(contract) => {
            let mut errors = Vec::new();
            let mut warnings = Vec::new();
            let mut patterns_compiled: u32 = 0;

            for rule in &contract.rules {
                patterns_compiled += (rule.forbidden.len() + rule.required.len()) as u32;
                if rule.scope.is_empty() {
                    warnings.push(format!("Rule {} has no scope patterns", rule.id));
                }
                if rule.title.is_empty() {
                    warnings.push(format!("Rule {} has no title", rule.id));
                }
            }

            if contract.meta.id.is_empty() {
                errors.push("contract_meta.id is empty".to_string());
            }

            Ok(NapiValidationResult {
                valid: errors.is_empty(),
                errors,
                warnings,
                rules_found: contract.rules.len() as u32,
                patterns_compiled,
            })
        }
        Err(e) => Ok(NapiValidationResult {
            valid: false,
            errors: vec![e],
            warnings: vec![],
            rules_found: 0,
            patterns_compiled: 0,
        }),
    }
}

#[napi]
pub fn parse_pattern(pattern_str: String) -> bool {
    let val = serde_yaml::Value::String(pattern_str);
    parse_yaml_pattern(&val).is_ok()
}
