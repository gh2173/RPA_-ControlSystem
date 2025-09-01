#!/bin/bash

# 폐쇄망 환경에서 nodemailer 설치 스크립트

echo "=== 폐쇄망 환경 nodemailer 설치 시작 ==="

# 1. nodemailer 직접 설치
if [ -f "nodemailer-7.0.5.tgz" ]; then
    echo "nodemailer 패키지 설치 중..."
    npm install nodemailer-7.0.5.tgz
    if [ $? -eq 0 ]; then
        echo "✅ nodemailer 설치 완료"
    else
        echo "❌ nodemailer 설치 실패"
        exit 1
    fi
else
    echo "❌ nodemailer-7.0.5.tgz 파일을 찾을 수 없습니다."
    echo "먼저 인터넷이 연결된 환경에서 'npm pack nodemailer' 명령으로 패키지를 다운로드하세요."
    exit 1
fi

# 2. package.json 업데이트
echo "package.json 업데이트 중..."
if command -v jq &> /dev/null; then
    # jq가 설치된 경우
    jq '.dependencies.nodemailer = "^7.0.5"' package.json > package.json.tmp && mv package.json.tmp package.json
else
    # jq가 없는 경우 수동으로 확인하도록 안내
    echo "⚠️  package.json에 nodemailer 의존성을 수동으로 추가해주세요:"
    echo '  "nodemailer": "^7.0.5"'
fi

# 3. 설치 확인
echo "설치 확인 중..."
node -e "try { require('nodemailer'); console.log('✅ nodemailer 로드 성공'); } catch(e) { console.error('❌ nodemailer 로드 실패:', e.message); process.exit(1); }"

echo "=== 설치 완료 ==="
echo "이제 server.js를 실행할 수 있습니다."