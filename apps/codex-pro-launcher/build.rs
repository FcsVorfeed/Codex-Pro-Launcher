fn main() {
    println!("cargo:rerun-if-env-changed=CODEX_PRO_REQUIRE_ADMIN_MANIFEST");

    // 这一段只在 Windows 构建时嵌入仓库内固定图标。
    // Embed the checked-in icon only for Windows builds.
    #[cfg(windows)]
    {
        let mut resource = winresource::WindowsResource::new();
        resource.set_icon("../../asset/codex-pro.ico");
        if std::env::var("CODEX_PRO_REQUIRE_ADMIN_MANIFEST")
            .ok()
            .as_deref()
            == Some("1")
        {
            resource.set_manifest(include_str!("windows-app-manifest.xml"));
        }
        let _ = resource.compile();
    }
}
