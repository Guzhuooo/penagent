# Run 41181149672 — final 0.4.0 native device build

- Run URL: https://github.com/Guzhuooo/penagent/actions/runs/41181149672
- Workflow: `.github/workflows/native-device-build.yml`
- Commit: `acabee799b76b1e1a102ed0303f06acf54404b90`
- 结论：`AArch64 plugin build (2018 toolchain + device bundle)` 全部成功。

## 产物与审计

- `libjsapi_httpx.so` 488,520 B / SHA-256
  `970b6a33bc568016d35291193f181af562963f76bdfe1af34d97022d4d10b4a6`
  （body 上限 2 MiB；与 run 41180136061 可复现一致）。
- ELF64 LE AArch64 DYN；SONAME 正确；无 PT_INTERP/RPATH/RUNPATH/TEXTREL；导出
  `custom_init_jsapis`；DT_NEEDED 对设备 provider SHA/SONAME 匹配；版本符号 ≤ 设备上限。
- 该 `.so` 已打入 0.4.0 AMR，并在 Y02 真机完成原生 HTTPS POST 200 / 过期证书 TLS_ERROR
  与 LAN mock 驱动的工作区 AI 文件闭环；真实 endpoint + 真实 key 仍未验证。
