/// 这一段让 Cargo 在 release 嵌入配置变化后重新编译 core crate。
/// Rebuild the core crate when the embedded release config changes.
fn main() {
    println!("cargo:rerun-if-env-changed=CODEX_PRO_RELEASE_CONFIG_JSON");
}
