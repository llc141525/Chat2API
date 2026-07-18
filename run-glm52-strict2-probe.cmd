@echo off
cd /d E:\Chat2API
powershell.exe -NoProfile -ExecutionPolicy Bypass -File E:\Chat2API\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "glm/GLM-5.2" -LogPath E:\Chat2API\glm52-strict2-dev.stdout.log -TimeoutSeconds 360 > E:\Chat2API\glm52-strict2-probe.stdout.log 2> E:\Chat2API\glm52-strict2-probe.stderr.log
