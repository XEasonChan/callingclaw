检查当前 main 分支相对上个 release tag 的所有变更：

1. `git log $(git describe --tags --abbrev=0)..HEAD --oneline` 列出所有 commit
2. 按 feat/fix/refactor/docs/chore 分类
3. 判断应该 bump MAJOR/MINOR/PATCH (按 semver 规则)
4. 更新版本号: VERSION, callingclaw/package.json, callingclaw-desktop/package.json, callingclaw/src/callingclaw.ts 中的 APP_VERSION fallback
5. 生成 CHANGELOG.md 条目 (按 Added/Changed/Fixed/Removed 分类)
6. 运行 `cd callingclaw && bunx tsc --noEmit` 检查编译
7. commit version bump: "chore: bump version to vX.Y.Z"
8. 创建 git tag: `git tag -a vX.Y.Z -m "CallingClaw vX.Y.Z"`
9. `git push origin main --tags`
10. `gh release create vX.Y.Z` 生成 GitHub Release (包含 changelog)
11. 输出 release summary 供用户确认
