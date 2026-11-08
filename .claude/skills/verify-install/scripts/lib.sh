# 공용: 모든 스크립트가 source 한다. 런처를 /tmp 에서 실행하므로 RUN_DIR 은 절대 경로로 만든다.
resolve_run_dir() { mkdir -p "$1" && (cd "$1" && pwd); }
install_dir() { node -p "JSON.parse(require('fs').readFileSync('$1/install.json','utf8')).dir"; }
server_port() { node -p "JSON.parse(require('fs').readFileSync('$1/server.json','utf8')).port"; }
# 증거 마스킹: 시리얼처럼 보이는 8자 이상 대문자·숫자 토큰은 끝 4자만, 홈 디렉터리는 <home>
mask_js='const mask=(s,home)=>s.replace(/\b[A-Z0-9]{8,}\b/g,(m)=>`…${m.slice(-4)}`).replaceAll(home,"<home>");'
