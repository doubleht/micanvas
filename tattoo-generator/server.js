const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const COOKIES_FILE = path.join(__dirname, 'mj_cookies.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// 사진 업로드
app.post('/api/photos/upload', upload.array('photos', 50), (req, res) => {
  const files = req.files.map(f => ({ name: f.originalname, file: f.filename, url: `/uploads/${f.filename}` }));
  res.json({ success: true, files });
});

// 사진 목록
app.get('/api/photos', (req, res) => {
  if (!fs.existsSync(UPLOADS_DIR)) return res.json({ photos: [] });
  const files = fs.readdirSync(UPLOADS_DIR)
    .filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f))
    .map(f => ({ file: f, url: `/uploads/${f}` }));
  res.json({ photos: files });
});

// 사진 삭제
app.delete('/api/photos/:filename', (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ success: true });
});

// 소재 추천 (채팅형)
app.post('/api/materials', (req, res) => {
  const { keyword, history } = req.body;
  const materials = generateMaterials(keyword);
  const reply = generateReply(keyword, materials, history);
  res.json({ materials, reply });
});

// 프롬프트 생성
app.post('/api/prompt', (req, res) => {
  const { material, style, placement } = req.body;
  res.json({ prompt: generatePrompt(material, style, placement) });
});

// 미드저니 로그인
app.post('/api/login', async (req, res) => {
  try {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('https://www.midjourney.com/login');
    await page.waitForURL('**/explore**', { timeout: 180000 });
    const cookies = await context.cookies();
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies));
    await browser.close();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 미드저니 전송 (사진 + 프롬프트)
app.post('/api/generate', async (req, res) => {
  const { prompt, photoFiles } = req.body;

  if (!fs.existsSync(COOKIES_FILE)) {
    return res.json({ success: false, error: '먼저 미드저니 로그인이 필요합니다' });
  }

  try {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE));
    await context.addCookies(cookies);

    const page = await context.newPage();
    await page.goto('https://www.midjourney.com/imagine');
    await page.waitForTimeout(3000);

    // 이미지 업로드 버튼 찾기
    if (photoFiles && photoFiles.length > 0) {
      const uploadBtn = await page.$('button[aria-label*="upload"], button[aria-label*="image"], [data-testid*="upload"]');
      if (uploadBtn) {
        for (const filename of photoFiles) {
          const filePath = path.join(UPLOADS_DIR, filename);
          if (fs.existsSync(filePath)) {
            const [fileChooser] = await Promise.all([
              page.waitForFileChooser(),
              uploadBtn.click()
            ]);
            await fileChooser.setFiles(filePath);
            await page.waitForTimeout(1500);
          }
        }
      }
    }

    // 프롬프트 입력
    const input = await page.waitForSelector('textarea, [contenteditable="true"], [data-testid="prompt-input"]', { timeout: 10000 });
    await input.click();
    await input.fill(prompt);
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);

    await browser.close();
    res.json({ success: true, message: '미드저니에 전송 완료!' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({ loggedIn: fs.existsSync(COOKIES_FILE) });
});

function generateReply(keyword, materials, history) {
  const base = keyword?.toLowerCase() || '';
  if (history && history.length > 2) {
    return `좋아요! "${materials.slice(0, 3).join(', ')}" 같은 소재들이 잘 어울릴 것 같아요. 아래에서 원하는 걸 골라보세요!`;
  }
  if (base.includes('신비') || base.includes('몽환') || base.includes('다크')) {
    return `오, 신비로운 느낌이군요! 달, 용, 봉황 같은 소재가 잘 맞을 것 같아요. 아래에서 골라보세요!`;
  }
  if (base.includes('귀여') || base.includes('작은') || base.includes('미니')) {
    return `미니멀하고 귀여운 타투 원하시는군요! 나비, 별, 꽃 같은 소재 어때요?`;
  }
  if (base.includes('강한') || base.includes('강렬') || base.includes('멋')) {
    return `강렬한 느낌! 늑대, 호랑이, 독수리 같은 소재가 딱이에요. 골라보세요!`;
  }
  return `"${keyword}" 관련 소재를 찾아봤어요! 아래에서 마음에 드는 걸 선택해주세요.`;
}

function generateMaterials(keyword) {
  const base = keyword?.toLowerCase() || '';
  const categoryMap = {
    '꽃': ['장미', '국화', '연꽃', '벚꽃', '모란', '튤립', '해바라기', '라벤더'],
    '동물': ['늑대', '호랑이', '독수리', '뱀', '사자', '여우', '사슴', '나비'],
    '자연': ['달', '별', '파도', '산', '번개', '불꽃', '구름', '나무'],
    '신화': ['용', '봉황', '유니콘', '메두사', '아누비스', '오딘', '연꽃신', '가루다'],
    '기하학': ['만다라', '삼각형', '원', '육각형', '나선형', '도트워크', '패턴'],
    '문자': ['한자', '룬문자', '아랍어', '산스크리트', '고딕체', '캘리그라피'],
  };
  for (const [cat, items] of Object.entries(categoryMap)) {
    if (base.includes(cat) || items.some(i => base.includes(i))) return items;
  }
  return ['장미', '늑대', '달', '만다라', '용', '나비', '호랑이', '파도', '독수리', '연꽃'];
}

function generatePrompt(material, style, placement) {
  const styleMap = {
    '블랙워크': 'blackwork tattoo design, bold black ink, high contrast',
    '파인라인': 'fine line tattoo design, delicate thin lines, minimalist',
    '트래디셔널': 'traditional tattoo design, bold outlines, classic colors',
    '리얼리즘': 'realism tattoo design, photorealistic, detailed shading',
    '워터컬러': 'watercolor tattoo design, soft colors, painterly effect',
    '재패니즈': 'japanese tattoo design, irezumi style, traditional japanese',
    '지오메트릭': 'geometric tattoo design, precise lines, sacred geometry',
    '네오트래드': 'neo traditional tattoo design, illustrative, vibrant colors',
    '색연필': 'colored pencil tattoo design, soft pencil strokes, pastel tones, hand-drawn texture',
  };
  const placementMap = {
    '팔': 'arm sleeve composition',
    '손목': 'wrist tattoo composition, small',
    '어깨': 'shoulder tattoo composition',
    '등': 'back tattoo composition, large',
    '발목': 'ankle tattoo composition, small',
    '가슴': 'chest tattoo composition',
    '목': 'neck tattoo composition, small',
    '허벅지': 'thigh tattoo composition',
  };
  const stylePrompt = styleMap[style] || 'blackwork tattoo design';
  const placementPrompt = placementMap[placement] || 'tattoo composition';
  return `${material} ${stylePrompt}, ${placementPrompt}, white background, professional tattoo flash art, clean design, high detail --ar 1:1 --v 6`;
}

app.listen(3000, () => console.log('서버 실행중: http://localhost:3000'));
