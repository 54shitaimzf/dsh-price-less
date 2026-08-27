# 插件内嵌 embedding 运行时。含 node_modules 二进制运行时（默认已被 .gitignore 排除），
# 复现/重建：
#   powershell -File scripts/setup_vendor.ps1
# 说明：
#   - @huggingface/transformers（CJS 构建）+ onnxruntime-node（CPU，win32-x64）
#   - sharp 为图像工具硬依赖：本运行时仅文本推理，安装后以存根满足 require（省 ~240MB）
#   - 默认裁剪：仅 win32-x64 CPU 后端（删 darwin/linux/arm64/GPU EP/wasm）
#   - 模型权重（models/，约 118MB）随插件包分发，离线可用；改档 embeddingTier: 'lite'
