const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  CONTENT_TYPES,
  MK_PICK_CATEGORIES,
  GEO_CHECKLIST_ITEMS,
  CURATED_TREND_TOPICS,
  detectBestContentType,
  recommendMkPickCategory,
  paraphraseNewsToMkFact,
  buildPresetScenario,
  buildDynamicWorkFromNews,
  extractFactSentencesFromSections
} = require('./public/mockData');

const PORT = process.env.PORT || 3000;
const IS_SERVERLESS = Boolean(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL);
const DATA_DIR = IS_SERVERLESS ? path.join(os.tmpdir(), 'mk-pick-data') : path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const SEED_DB_PATH = path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

function decodeXmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// API 키 없이 유튜브 검색 페이지(ytInitialData)에서 실시간 유튜브 쇼츠(#shorts) 영상·조회수·링크를 추출하는 함수
async function fetchYouTubeShorts(keyword, limit = 4) {
  const q = (keyword || '편의점 신상').trim() + ' #shorts';
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9'
      }
    });
    if (!res.ok) return [];
    const html = await res.text();
    const match = html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
    if (!match) return [];
    const jsonStr = match[1];

    const results = [];
    const seen = new Set();

    // 1) reelItemRenderer / shortsLockupViewModel 추출
    const shortsRegex = /"videoId":"([a-zA-Z0-9_-]{11})"[\s\S]{1,600}?"(?:headline|title)":\{"(?:simpleText|runs)":(?:\[\{"text":")?([^"\]\}]+)/g;
    let m;
    while ((m = shortsRegex.exec(jsonStr)) !== null && results.length < limit) {
      const videoId = m[1];
      const rawTitle = decodeXmlEntities(m[2]);
      if (!seen.has(videoId) && rawTitle && rawTitle.length > 3) {
        seen.add(videoId);
        results.push({
          videoId,
          title: rawTitle,
          link: `https://www.youtube.com/shorts/${videoId}`,
          source: '유튜브 쇼츠(Shorts)',
          pubDateShort: '숏폼 바이럴'
        });
      }
    }
    return results;
  } catch (err) {
    console.error('YouTube Shorts fetch error:', err.message);
    return [];
  }
}

// 실시간 한국어 뉴스 검색 (기본 최근 30일, 트렌드 발굴 시 최근 7일 필터 적용)
async function fetchRealTimeKoreanNews(keyword, limit = 6, when = '30d') {
  const q = (keyword || '').trim();
  if (!q) return [];
  const fullQuery = when && !q.includes('when:') ? `${q} when:${when}` : q;
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(fullQuery)}&hl=ko&gl=KR&ceid=KR:ko`;
    const res = await fetch(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    const items = [];
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
      const block = match[1];
      const rawTitle = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const rawLink = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const rawPubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      const rawSource = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '언론 보도';

      let cleanTitle = decodeXmlEntities(rawTitle);
      const cleanSource = decodeXmlEntities(rawSource);
      if (cleanSource && cleanTitle.endsWith(' - ' + cleanSource)) {
        cleanTitle = cleanTitle.slice(0, -(' - ' + cleanSource).length).trim();
      }

      let pubDateShort = '';
      if (rawPubDate) {
        const d = new Date(rawPubDate);
        if (!Number.isNaN(d.getTime())) {
          pubDateShort = d.toISOString().slice(0, 10);
        }
      }

      if (cleanTitle) {
        items.push({
          title: cleanTitle,
          link: rawLink.trim(),
          source: cleanSource || '주요 언론',
          pubDateShort
        });
      }
    }
    // 만약 최근 기간(when:30d) 내 기사가 0건이면 기간 제한 없이 재검색
    if (items.length === 0 && when) {
      return fetchRealTimeKoreanNews(keyword, limit, '');
    }
    return items;
  } catch (err) {
    console.error('Live RSS fetch error:', err.message);
    return [];
  }
}

// JSON 객체 내부의 모든 문자열에서 Perplexity 각주 번호([1], [2] 등)를 깔끔하게 제거하는 헬퍼
function stripCitationBrackets(val) {
  if (typeof val === 'string') {
    return val.replace(/\s*\[\d+\]/g, '').trim();
  }
  if (Array.isArray(val)) {
    return val.map(stripCitationBrackets);
  }
  if (val && typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val)) {
      out[k] = stripCitationBrackets(val[k]);
    }
    return out;
  }
  return val;
}

// Perplexity API 실시간 사용량·비용(버닝) 추적 및 30분 트렌드 캐시 (단순 F5 새로고침 시 중복 과금 원천 방지)
const TREND_CACHE_TTL_MS = 30 * 60 * 1000; // 30분 캐시
let cachedTrendRadar = null;
let cachedTrendTimestamp = 0;

const apiUsageStats = {
  model: 'sonar',
  totalCalls: 0,
  trendCalls: 0,
  draftCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
  estimatedCostKrw: 0,
  lastCalledAt: null,
  cacheHitsOnRefresh: 0
};

function recordPerplexityUsage(usage = {}, callType = 'draft') {
  const pTokens = Number(usage.prompt_tokens) || 950;
  const cTokens = Number(usage.completion_tokens) || 1450;
  apiUsageStats.totalCalls += 1;
  if (callType === 'trend') apiUsageStats.trendCalls += 1;
  else apiUsageStats.draftCalls += 1;

  apiUsageStats.promptTokens += pTokens;
  apiUsageStats.completionTokens += cTokens;
  apiUsageStats.totalTokens += pTokens + cTokens;

  // Perplexity sonar 공식 요금: 요청당 $0.005 ($5 / 1K requests) + 입력 $1/1M tokens + 출력 $1/1M tokens
  const callCostUsd = 0.005 + (pTokens / 1_000_000) * 1.0 + (cTokens / 1_000_000) * 1.0;
  apiUsageStats.estimatedCostUsd = Number((apiUsageStats.estimatedCostUsd + callCostUsd).toFixed(5));
  apiUsageStats.estimatedCostKrw = Math.round(apiUsageStats.estimatedCostUsd * 1380);
  apiUsageStats.lastCalledAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// Perplexity API 실시간 호출 헬퍼 (search_recency_filter 적용 + 각주 번호 제거 + 토큰/비용 기록)
async function callPerplexityJson(apiKey, systemPrompt, userPrompt, recencyFilter = 'month', callType = 'draft') {
  const payload = {
    model: 'sonar',
    temperature: 0.2,
    search_recency_filter: recencyFilter,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Perplexity API 호출 실패 (${res.status}): ${errText.slice(0, 120)}`);
  }

  const data = await res.json();
  recordPerplexityUsage(data?.usage, callType);
  const content = data?.choices?.[0]?.message?.content || '';
  const citations = Array.isArray(data?.citations) ? data.citations : [];

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Perplexity 응답에서 JSON 구조를 추출하지 못했습니다.');
  }
  const parsed = stripCitationBrackets(JSON.parse(jsonMatch[0]));
  return { parsed, citations };
}

// Perplexity API + 최근 7일 실시간 뉴스·쇼츠·구글트렌드 원시 데이터를 결합해 '진짜 이번 주 최신 트렌드' 발굴 (탭별 10개씩, 탭 간 중복 방지)
async function fetchPerplexityTrends(apiKey, rawLiveContext) {
  const sys = `당신은 매일경제 디지털뉴스룸(MK Pick) 실시간 트렌드 데스크입니다.
철칙:
1. '두바이 초콜릿/쿠키', '버터떡', '우베', '탕후루', '요아정'처럼 이미 유행이 지났거나 연말·분기 결산 회고 기사에 나오는 과거 유행어를 절대 포함하지 마세요.
2. 반드시 아래 제공된 [최근 7일 이내 실시간 보도·쇼츠·구글트렌드 원시 데이터]에 등장하는 이번 주 실제 신상품, 품절템, 팝업스토어, MZ 소비 현상만 선별하세요.
3. 4개 탭(shortFormTrends, newsletterTrends, portalRetailTrends, googleTrends) 각각 정확히 10개씩 작성하되, 같은 브랜드나 같은 주제를 중복해서 넣지 마세요.
4. 각주 번호([1], [2])를 넣지 말고 순수 JSON 객체만 출력하세요.`;

  const usr = `[이번 주(최근 7일 이내) 실제 수집된 카테고리별 실시간 한국 뉴스·쇼츠·급상승 검색어 원시 데이터]
${rawLiveContext}

위 최근 7일 이내 실시간 데이터를 바탕으로, 탭별로 서로 겹치지 않는 **10개씩(각 배열당 10개 항목 필수)**을 JSON으로 정리하세요.
- keyword는 2~4어절의 직관적인 최신 트렌드 키워드로 작성하세요 (예: "다이소 5000원 겨울 니트", "유한양행 다이소 더마푸라민Rx", "편의점 반값 패딩 열풍", "2030 백화점 코어룩", "한남동 팔란티어 팝업 품절", "이마트 와우샵 1만원 가전", "제로 주세요 영점소비", "함양 오르GO 굿즈 팝업" 등).
- desc는 구체적인 브랜드명·가격·수치·일정을 담아 "~합니다" 체 1문장으로 작성하세요.

{
  "shortFormTrends": [{"keyword": "숏폼·바이럴·오픈런 키워드 (10개)", "badge": "🎬 쇼츠·릴스 화제", "desc": "이번 주 화제 이유와 수치 1문장"}],
  "newsletterTrends": [{"keyword": "MZ 소비문화·패션·신조어 키워드 (10개)", "category": "MZ·소비 이슈", "desc": "이번 주 화제 이유와 수치 1문장"}],
  "portalRetailTrends": [{"keyword": "편의점·다이소·백화점 신상 키워드 (10개)", "badge": "포털·유통 신상", "desc": "이번 주 출시·품절·프로모션 팩트 1문장"}],
  "googleTrends": [{"keyword": "오늘·이번주 급상승 키워드 (10개)", "badge": "실시간 급상승", "desc": "급상승 배경 1문장"}]
}`;
  const { parsed } = await callPerplexityJson(apiKey, sys, usr, 'week', 'trend');
  return parsed;
}

// Perplexity API를 활용해 선택한 콘텐츠 유형(1~5번)에 맞춘 매경 MK Pick 기사 초안 생성
async function buildPerplexityEnhancedScenario({ apiKey, keyword, company, url, rawText, typeId, newsItems, baseScenario }) {
  const tInfo = CONTENT_TYPES[typeId] || CONTENT_TYPES[4];
  const newsContext = (newsItems || [])
    .slice(0, 6)
    .map((n, i) => `${i + 1}. [${n.source}] ${n.title} (${n.link})`)
    .join('\n');

  const typeInstructions = {
    1: '유형 1(유료 업체 타겟팅 기획 콘텐츠): 1단락은 과거 일괄 방식 vs 현재 맞춤형 시대별 변화 비교, 2단락은 타깃 파트너사 및 주요 기업 4곳의 핵심 서비스·혜택 집중 소개, 3단락은 실패 없는 업체 선택 기준. 요약표는 업체별 서비스·혜택·추천대상 비교표, FAQ는 7문항.',
    2: '유형 2(특정 기념일 관련 콘텐츠): 1단락은 기념일 유래·법적 지정 배경, 2단락은 정부·지자체 공식 지원 제도 및 바우처, 3단락은 이 기념일을 맞아 참여하는 주요 브랜드 3~5곳을 선정해 반드시 본문 안에 "■ [브랜드명] 캠페인·제품·마케팅명" 형태의 소항목으로 나누어 각 브랜드별 프로모션·제품·ESG 활동을 구체적으로 각각 소개할 것(임산부의 날 기사처럼 여러 브랜드가 한눈에 보이도록 구성). 요약표는 브랜드별 캠페인/제품·혜택·참여조건·기간 비교표, FAQ는 5문항.',
    3: '유형 3(최신 트렌드 반영 콘텐츠 1 - SNS·숏폼 바이럴 확장): 1단락은 과거 원조 유행부터 현재까지 연대별 계보, 2단락은 MZ세대가 열광하는 소비 심리 4가지 분석, 3단락은 목적형 소비 진화와 문화·유통 시사점. 요약표는 세대·시기별 유행 아이템 비교표, FAQ는 5문항.',
    4: '유형 4(최신 트렌드 반영 콘텐츠 2 - 신제품 출시를 거시적 마케팅 키워드로 재정의): 1단락은 개별 신제품들을 관통하는 거시적 마케팅 콘셉트 도출, 2단락은 브랜드·유통 채널별 전용 라인업 및 사례 비교, 3단락은 품절 대란 속 입고 시간·구매 팁과 시사점. 요약표는 브랜드·채널별 라인업·차별점·구매팁 비교표, FAQ는 5문항.',
    5: '유형 5(영업 기업 맞춤 기획 콘텐츠): 1단락은 독자 질문 도입 1문단 뒤 Q1~Q4 시장 메가 트렌드·소비자 페인포인트 문답, 2단락은 Q5~Q6 선택 기준 문답 후 마지막 Q7에서 영업 타깃 기업의 핵심 솔루션·경쟁력을 집중 소개. 요약표는 대상 기업 핵심 기능·기대효과 요약표, FAQ는 7문항.'
  };

  const faqCount = (typeId === 1 || typeId === 5) ? 7 : 5;
  const fallbackCat = recommendMkPickCategory(keyword, typeId, company);
  const sys = `당신은 매일경제 MK Pick(GEO·AEO 최적화 기사) 전문 기자입니다.
타 언론사 기사의 문장을 절대 그대로 베끼지 말고, 수치·브랜드명·날짜 등 핵심 팩트만 추출하여 모든 본문과 답변을 매일경제 고유의 정중하고 분석적인 "~합니다/습니다" 체로 작성하세요.

[MK Pick 카테고리 분류 규칙]
- 기사 내용과 콘텐츠 스타일에 맞춰 다음 5가지 공식 카테고리 중 가장 적합한 1개를 "mkCategory"로 추천하고, 추천 이유를 "mkCategoryReason"에 1문장으로 작성하세요:
  1) "산업 Q&A" (업계 트렌드·소비 현상·유행 배경 문답 해설)
  2) "제품·기술" (신제품 출시·팝업스토어·라인업·혁신 기술 집중 분석)
  3) "성공사례" (시장 페인포인트를 해결한 특정 기업·플랫폼의 성장 전략)
  4) "기업뉴스" (법정기념일·시즌 이슈에 맞춘 다수 기업들의 프로모션·ESG 캠페인 종합)
  5) "브랜드스토리(기업관)" (파트너 브랜드의 핵심 가치·맞춤형 서비스 스토리 조명)

[소제목 작성 필수 규칙]
- 본문 각 단락의 소제목(draftSections[].title)은 앞에 번호(1, 2, 3)를 붙이거나 딱딱한 보고서식 명사구(예: "주요 참여 주체별 활동", "정부 지원제도와의 구분")로 쓰지 마세요.
- 반드시 독자의 호기심과 검색 의도를 자극하는 자연스러운 한 줄 질문형 소제목(예: "왜 지금 '오르GO 팝업'에 주말 나들이객이 몰릴까요?", "현장에서 어떤 한정판 굿즈와 체험 혜택을 받을 수 있나요?", "방문 전 꼭 확인해야 할 운영 시간과 참여 방법은 무엇인가요?")으로 작성하세요.
- 특히 [유형 2: 특정 기념일 관련 콘텐츠]인 경우, 3번째 단락 본문(draftSections[2].content)에서는 여러 참여 브랜드(최소 3~5곳)를 각각 "■ [브랜드명] 캠페인·제품·마케팅 핵심 내용" 형태로 구분하여 각 브랜드가 어떤 제품·캠페인·할인을 펼치는지 구체적으로 소개하세요.

[FAQ 및 팬아웃(Query Fan-out) 추천 질문 작성 필수 규칙]
- FAQ 질문(faqs[].q)은 절대 딱딱한 기계식 문어체("~입니까?", "~무엇입니까?")로 쓰지 마세요.
- 반드시 실제 독자가 네이버·구글·퍼플렉시티·챗GPT 검색창에 직접 물어볼 법한 생생한 구어체 자연어 질의 형식(예: "Q1. 용산 아이파크몰 오르GO 함양 팝업은 사전 예약 없이 현장 방문해도 되나요?", "Q2. 마루·올라 캐릭터 키링이나 한정판 굿즈는 무료로 받을 수 있는 방법이 있나요?", "Q3. 아이나 부모님과 주말에 방문할 때 대기 시간이나 주차 팁이 있을까요?")으로 총 ${faqCount}문항을 작성하세요.
- FAQ 답변(faqs[].a)은 단답형 1줄로 끝내지 말고, 구체적인 수치·장소·참여 조건을 포함한 완결된 2문장("~합니다/습니다" 체)으로 작성하세요.
- 팬아웃 추천 질문(fanoutQuestions)은 핵심 주제에서 꼬리에 꼬리를 물고 확장되는 '쿼리 팬아웃(Query Fan-out)' 기법을 적용해 ▲예약·대기시간 ▲가격·무료혜택 조건 ▲위치·주차·대중교통 ▲1인 구매·참여 제한 ▲동반 방문(아이·연인·선물) 팁 ▲기존 유사 행사·타 브랜드와의 차이점 ▲사후 혜택·앱 연동 ▲주의사항 등 8가지 다각도 검색 의도를 반영한 자연어 질문(q)과 구체적인 답변(a) 8개를 반드시 생성하세요.
- 절대로 본문이나 FAQ에 "검색된 자료만으로는 확인되지 않는다", "법정기념일 행사가 아니다", "확대해석하기 어렵다" 같은 AI 메타 해명 문구를 넣지 마세요.
반드시 순수 JSON 객체만 출력하세요.`;

  const usr = `[작성 요청 정보]
- 키워드/주제: ${keyword}
- 타깃 기업/브랜드(선택): ${company || '관련 주요 기업·브랜드'}
- 참고 URL: ${url || '없음'}
- 추가 보도자료/메모: ${rawText || '없음'}
- 선택된 콘텐츠 유형: ${tInfo.shortName} (${tInfo.desc})
- 유형별 필수 구성 지침: ${typeInstructions[typeId] || typeInstructions[4]}
- 실시간 참고 뉴스/쇼츠 목록:
${newsContext || '실시간 웹 검색 결과를 바탕으로 최신 팩트 반영'}

아래 JSON 스키마에 맞춰 한국어로 작성하세요:
{
  "mkCategory": "산업 Q&A | 제품·기술 | 성공사례 | 기업뉴스 | 브랜드스토리(기업관) 중 택 1",
  "mkCategoryReason": "이 기사에 해당 MK Pick 카테고리를 추천한 이유 1문장 (~합니다 체)",
  "titleCandidates": [
    {"id": "tc-1", "title": "\\"큰따옴표 인용구\\"…핵심 키워드 포함 설명형 제목", "totalScore": 96},
    {"id": "tc-2", "title": "\\"큰따옴표 인용구\\"…설명형 제목 2", "totalScore": 93},
    {"id": "tc-3", "title": "\\"큰따옴표 인용구\\"…설명형 제목 3", "totalScore": 90},
    {"id": "tc-4", "title": "\\"큰따옴표 인용구\\"…설명형 제목 4", "totalScore": 88},
    {"id": "tc-5", "title": "\\"큰따옴표 인용구\\"…설명형 제목 5", "totalScore": 85}
  ],
  "researchFacts": [
    {"category": "핵심 팩트 분류", "fact": "수치·브랜드명이 포함된 ~합니다 체 팩트 문장 1"},
    {"category": "핵심 팩트 분류", "fact": "수치·브랜드명이 포함된 ~합니다 체 팩트 문장 2"},
    {"category": "핵심 팩트 분류", "fact": "수치·브랜드명이 포함된 ~합니다 체 팩트 문장 3"},
    {"category": "핵심 팩트 분류", "fact": "수치·브랜드명이 포함된 ~합니다 체 팩트 문장 4"}
  ],
  "subtitle": "기사 부제 2줄 (줄바꿈 \\n 사용)",
  "aiFactSummary": [
    "1. 핵심 팩트 요약 첫 번째 문장 (~합니다 체)",
    "2. 핵심 팩트 요약 두 번째 문장 (~합니다 체)",
    "3. 핵심 팩트 요약 세 번째 문장 (~합니다 체)"
  ],
  "draftSections": [
    {
      "id": "sec-1",
      "title": "번호 없이 독자 호기심을 자극하는 첫 번째 질문형 소제목 (~할까요? / ~인가요?)",
      "content": "첫 문장은 반드시 독자에게 말을 거는 질문형('~하신 적 없으신가요?')으로 시작하고, 이어서 구체적인 수치·브랜드 팩트를 담아 2~3문단(~합니다 체)으로 상세히 작성"
    },
    {
      "id": "sec-2",
      "title": "번호 없이 독자 호기심을 자극하는 두 번째 질문형 소제목 (~할까요? / ~인가요?)",
      "content": "유형 지침에 맞춰 구체적 기업·브랜드 사례, 수치, 비교 내용을 2~3문단(~합니다 체)으로 상세히 작성"
    },
    {
      "id": "sec-3",
      "title": "번호 없이 독자 호기심을 자극하는 세 번째 질문형 소제목 (~할까요? / ~인가요?)",
      "content": "유형 지침에 맞춘 세 번째 단락 내용 (~합니다 체)"
    }
  ],
  "summaryTable": {
    "title": "[요약표] 유형에 맞는 비교표 제목",
    "headers": ["구분1", "구분2", "구분3", "구분4"],
    "rows": [
      ["행1-1", "행1-2", "행1-3", "행1-4"],
      ["행2-1", "행2-2", "행2-3", "행2-4"],
      ["행3-1", "행3-2", "행3-3", "행3-4"]
    ]
  },
  "faqs": [
    {"q": "Q1. 사람들이 실제로 검색창에 물어볼 법한 구어체 자연어 질문 (~나요? / ~할까요?)", "a": "구체적인 수치·장소·조건이 담긴 2문장 완결형 답변 (~합니다 체)"}
  ],
  "fanoutQuestions": [
    {"category": "예약·대기", "q": "사전 예약 없이 주말에 현장 방문해도 바로 입장할 수 있나요?", "a": "구체적인 이용 팁 답변 (~합니다 체)"},
    {"category": "가격·혜택", "q": "무료로 굿즈나 할인 쿠폰을 받으려면 현장에서 어떻게 참여해야 하나요?", "a": "구체적인 혜택 조건 답변 (~합니다 체)"},
    {"category": "위치·교통", "q": "정확한 행사장 위치와 주차·대중교통 방문 시 가장 빠른 동선은 어디인가요?", "a": "구체적인 위치·동선 답변 (~합니다 체)"},
    {"category": "구매·수량제한", "q": "한정판 굿즈나 특가 상품은 1인당 구매 수량 제한이 있나요?", "a": "구체적인 수량 및 조기 소진 안내 (~합니다 체)"},
    {"category": "동반·선물팁", "q": "아이와 함께 가족 나들이로 가거나 지인 선물용으로 구매하기에 괜찮을까요?", "a": "구체적인 추천 대상 및 체험 포인트 (~합니다 체)"},
    {"category": "차별점·비교", "q": "기존에 열렸던 유사 팝업이나 타 브랜드 상품과 비교해 어떤 점이 가장 특별한가요?", "a": "구체적인 차별점 답변 (~합니다 체)"},
    {"category": "온라인·앱연동", "q": "현장에 직접 가지 못해도 모바일 앱이나 온라인으로 참여할 수 있는 방법이 있나요?", "a": "구체적인 온라인·앱 연계 안내 (~합니다 체)"},
    {"category": "후속일정·주의사항", "q": "행사 종료 후에도 상시 구매하거나 다음 일정을 확인할 수 있는 공식 채널은 어디인가요?", "a": "구체적인 공식 채널 및 사후 이용 안내 (~합니다 체)"}
  ],
  "oneLineSummary": "한 줄 요약! 전체 핵심 요약 1~2문장 (~합니다 체)"
}`;

  const { parsed, citations } = await callPerplexityJson(apiKey, sys, usr);

  // 출처 병합
  const mergedSources = [...(baseScenario.sources || [])];
  citations.slice(0, 5).forEach((citUrl, i) => {
    if (typeof citUrl === 'string' && !mergedSources.some(s => s.url === citUrl)) {
      mergedSources.push({
        id: `src-pplx-${i + 1}`,
        url: citUrl,
        title: `[Perplexity 실시간 검증 출처 #${i + 1}] ${citUrl}`,
        method: 'Perplexity 실시간 검색',
        reliability: '높음',
        excluded: false
      });
    }
  });

  const researchItems = Array.isArray(parsed.researchFacts) && parsed.researchFacts.length > 0
    ? parsed.researchFacts.map((rf, i) => ({
        id: `ri-pplx-${i + 1}`,
        category: rf.category || `Perplexity 추출 팩트 #${i + 1}`,
        fact: rf.fact,
        rawReference: 'Perplexity 실시간 웹 검색 및 매경 문체 재가공',
        sourceIds: [mergedSources[i % Math.max(1, mergedSources.length)]?.id].filter(Boolean)
      }))
    : baseScenario.researchItems;

  const draftSections = Array.isArray(parsed.draftSections) && parsed.draftSections.length > 0
    ? parsed.draftSections.map((sec, i) => ({
        id: sec.id || `sec-${i + 1}`,
        title: sec.title || `단락 ${i + 1}`,
        subtitle: sec.subtitle || '',
        content: sec.content || '',
        sourceIds: mergedSources.slice(0, 2).map(s => s.id)
      }))
    : baseScenario.draftSections;

  const validCategories = ['산업 Q&A', '제품·기술', '성공사례', '기업뉴스', '브랜드스토리(기업관)'];
  const pickedCategory = validCategories.includes((parsed.mkCategory || '').trim())
    ? parsed.mkCategory.trim()
    : fallbackCat.recommendedCategory;
  const pickedCatReason = (parsed.mkCategoryReason || '').trim() || fallbackCat.categoryReason;

  const summaryBlocks = {
    ...baseScenario.summaryBlocks,
    mkCategory: pickedCategory,
    mkCategoryReason: pickedCatReason,
    byline: `${pickedCategory} | 남궁선희 기자 | 입력 ${new Date().toISOString().slice(0, 10).replace(/-/g, '.')} 10:00`,
    subtitle: parsed.subtitle || baseScenario.summaryBlocks.subtitle,
    aiFactSummary: Array.isArray(parsed.aiFactSummary) && parsed.aiFactSummary.length > 0
      ? parsed.aiFactSummary
      : baseScenario.summaryBlocks.aiFactSummary,
    summaryTable: parsed.summaryTable && Array.isArray(parsed.summaryTable.headers)
      ? parsed.summaryTable
      : baseScenario.summaryBlocks.summaryTable,
    faqs: Array.isArray(parsed.faqs) && parsed.faqs.length > 0
      ? parsed.faqs.map((f, i) => ({
          q: /^Q\d+\./i.test((f.q || '').trim()) ? f.q.trim() : `Q${i + 1}. ${(f.q || '').trim()}`,
          a: (f.a || '').trim()
        }))
      : baseScenario.summaryBlocks.faqs,
    fanoutQuestions: Array.isArray(parsed.fanoutQuestions) && parsed.fanoutQuestions.length > 0
      ? parsed.fanoutQuestions.map((fq, i) => ({
          id: `fq-pplx-${i + 1}`,
          category: fq.category || '연관 질문',
          q: (fq.q || '').replace(/^Q\d+\.\s*/i, '').trim(),
          a: (fq.a || '').trim()
        }))
      : baseScenario.summaryBlocks.fanoutQuestions,
    oneLineSummary: parsed.oneLineSummary || baseScenario.summaryBlocks.oneLineSummary
  };

  const titleCandidates = Array.isArray(parsed.titleCandidates) && parsed.titleCandidates.length > 0
    ? parsed.titleCandidates
    : baseScenario.titleCandidates;

  return {
    ...baseScenario,
    sources: mergedSources,
    researchItems,
    titleCandidates,
    selectedTitleId: titleCandidates[0]?.id || 'tc-1',
    draftSections,
    summaryBlocks,
    factChecks: extractFactSentencesFromSections(draftSections, mergedSources),
    usedPerplexity: true
  };
}

// 실시간 트렌드 키워드 수집 (최근 7일 실시간 뉴스·구글트렌드·유튜브쇼츠 원시 수집 후 Perplexity로 정제)
async function fetchLiveTrendRadar(apiKey = '', forcePerplexity = false) {
  const googleTrends = [];
  const portalRetailTrends = [];
  const shortFormTrends = [];
  const rawContextLines = [];

  // 1) Google Trends KR 오늘 실시간 급상승 (최대 10개)
  try {
    const gRes = await fetch('https://trends.google.co.kr/trending/rss?geo=KR', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (gRes.ok) {
      const gXml = await gRes.text();
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let m;
      while ((m = itemRegex.exec(gXml)) !== null && googleTrends.length < 10) {
        const block = m[1];
        const title = decodeXmlEntities((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
        const traffic = decodeXmlEntities((block.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/) || [])[1] || '급상승');
        const newsTitle = decodeXmlEntities((block.match(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/) || [])[1] || '');
        if (title) {
          googleTrends.push({
            keyword: title,
            badge: `검색량 ${traffic}`,
            desc: newsTitle || `${title} 관련 오늘 실시간 급상승 검색 트렌드`
          });
          rawContextLines.push(`[구글트렌드 실시간] ${title} (${traffic}): ${newsTitle}`);
        }
      }
    }
  } catch (e) {
    // ignore
  }

  // 2) 최근 7일(when:7d) 카테고리별 실제 최신 뉴스 4종 + 실시간 유튜브 쇼츠 수집
  const fallbackNewsletterPool = [...(CURATED_TREND_TOPICS.newsletter || [])];
  try {
    const [retailNews, viralNews, mzCultureNews, ytShorts] = await Promise.all([
      fetchRealTimeKoreanNews('(다이소 OR 편의점 OR 올리브영 OR 이마트 OR 백화점) (출시 OR 신상 OR 단독 OR 5000원 OR 반값)', 14, '7d'),
      fetchRealTimeKoreanNews('(품절 OR 오픈런 OR 팝업스토어 OR 굿즈 OR 콜라보)', 14, '7d'),
      fetchRealTimeKoreanNews('(2030 OR MZ세대 OR 유행 OR 열풍) (패션 OR 뷰티 OR 소비 OR 디저트)', 14, '7d'),
      fetchYouTubeShorts('편의점 신상 다이소 품절템 팝업스토어', 10)
    ]);

    retailNews.forEach(n => {
      rawContextLines.push(`[탭3 포털·유통 신상 (${n.pubDateShort})] ${n.title} (${n.source})`);
      const quoted = (n.title.match(/['‘“"]([^'’”"]{2,18})['’”"]/) || [])[1];
      const fallbackKw = n.title.replace(/\[[^\]]*\]/g, '').split(/[,…·?!]/)[0].trim().slice(0, 20);
      const kw = quoted || fallbackKw;
      if (kw && portalRetailTrends.length < 10 && !portalRetailTrends.some(p => p.keyword === kw)) {
        portalRetailTrends.push({
          keyword: kw,
          badge: `${n.source} · ${n.pubDateShort || '최신'}`,
          desc: paraphraseNewsToMkFact(n.title, kw, n.source).paraphrasedSentence
        });
      }
    });

    viralNews.forEach(vn => {
      rawContextLines.push(`[탭1 쇼츠·바이럴·오픈런 (${vn.pubDateShort})] ${vn.title} (${vn.source})`);
      const quoted = (vn.title.match(/['‘“"]([^'’”"]{2,18})['’”"]/) || [])[1];
      const fallbackKw = vn.title.replace(/\[[^\]]*\]/g, '').split(/[,…·?!]/)[0].trim().slice(0, 20);
      const kw = quoted || fallbackKw;
      if (kw && shortFormTrends.length < 10 && !shortFormTrends.some(s => s.keyword === kw)) {
        shortFormTrends.push({
          keyword: kw,
          badge: `🎬 바이럴 · ${vn.pubDateShort || '최신'}`,
          desc: paraphraseNewsToMkFact(vn.title, kw, vn.source).paraphrasedSentence
        });
      }
    });

    mzCultureNews.forEach(mn => {
      if (!/휩쓴|결산|총정리/.test(mn.title)) {
        rawContextLines.push(`[탭2 MZ·뉴스레터 소비트렌드 (${mn.pubDateShort})] ${mn.title} (${mn.source})`);
      }
    });

    ytShorts.forEach(yt => {
      const cleanKw = yt.title
        .replace(/#[a-zA-Z0-9가-힣_]+/g, '')
        .replace(/[\[\](){}]/g, ' ')
        .trim()
        .slice(0, 22);
      if (cleanKw) {
        rawContextLines.push(`[탭1 실시간 유튜브 쇼츠] ${cleanKw}`);
        if (shortFormTrends.length < 10 && !shortFormTrends.some(s => s.keyword === cleanKw)) {
          shortFormTrends.push({
            keyword: cleanKw,
            badge: '🎬 유튜브 쇼츠 인기',
            desc: `유튜브 쇼츠에서 확산 중인 '${cleanKw}' 소비자 리뷰·언박싱 트렌드`
          });
        }
      }
    });
  } catch (e) {
    // ignore
  }

  // 각 배열이 최소 10개를 유지하도록 보충하는 헬퍼
  function ensureTenItems(primaryList = [], backupList = []) {
    const out = [...primaryList];
    for (const item of backupList) {
      if (out.length >= 10) break;
      if (!out.some(x => x.keyword === item.keyword)) {
        out.push(item);
      }
    }
    return out.slice(0, 10);
  }

  // 3) Perplexity API 키가 연결된 경우: 방금 수집한 최근 7일 실시간 뉴스·쇼츠·구글트렌드 원시 데이터를 바탕으로 정교하게 큐레이션 (탭당 10개 보장)
  if (apiKey && forcePerplexity) {
    try {
      const pplxTrends = await fetchPerplexityTrends(apiKey, rawContextLines.join('\n'));
      if (pplxTrends && Array.isArray(pplxTrends.shortFormTrends)) {
        return {
          shortFormTrends: ensureTenItems(pplxTrends.shortFormTrends, [...shortFormTrends, ...fallbackNewsletterPool]),
          newsletterTrends: ensureTenItems(pplxTrends.newsletterTrends || [], fallbackNewsletterPool),
          portalRetailTrends: ensureTenItems(pplxTrends.portalRetailTrends || [], [...portalRetailTrends, ...fallbackNewsletterPool]),
          googleTrends: ensureTenItems(googleTrends, [...(pplxTrends.googleTrends || []), ...portalRetailTrends]),
          usedPerplexity: true
        };
      }
    } catch (e) {
      console.error('Perplexity trend radar fallback:', e.message);
    }
  }

  if (shortFormTrends.length === 0) {
    shortFormTrends.push(
      { keyword: '편의점 신상 꿀조합 레시피', badge: '🎬 쇼츠·릴스 화제', desc: '유튜브 쇼츠와 인스타 릴스에서 수백만 조회수를 기록 중인 편의점 신상품 조합 트렌드' },
      { keyword: '다이소 뷰티 갓성비 하울', badge: '📱 릴스·쇼츠 바이럴', desc: '숏폼 크리에이터들의 발색·성분 비교 영상으로 품절 대란이 이어지는 다이소 화장품 열풍' },
      { keyword: '수건케이크 · 과일모찌 ASMR', badge: '🎬 쇼츠 먹방 열풍', desc: '단면을 자르는 시각적 효과와 식감 ASMR 영상으로 MZ세대 오픈런을 부른 디저트 트렌드' }
    );
  }

  if (googleTrends.length === 0) {
    googleTrends.push(
      { keyword: '초코파이 리뉴얼', badge: '검색량 500+', desc: '장수 제과 브랜드 신제품 및 리뉴얼 출시로 급상승한 키워드' },
      { keyword: '다이소 더마 뷰티', badge: '검색량 1000+', desc: '제약사 협업 3,000~5,000원대 가성비 스킨케어 라인업 화제' },
      { keyword: '성수동 팝업스토어', badge: '검색량 500+', desc: '주말 방문객이 몰리는 패션·뷰티 체험형 팝업스토어 트렌드' }
    );
  }

  if (portalRetailTrends.length === 0) {
    portalRetailTrends.push(
      { keyword: '편의점 전용 신상 디저트', badge: '포털 유통 화제', desc: '편의점 채널별로 단독 출시되는 베이커리·디저트 도장깨기 열풍' },
      { keyword: '다이소 뷰티 오픈런', badge: '포털 쇼핑 화제', desc: '소용량·균일가 화장품 품귀 현상과 입고 알림 신청 증가' }
    );
  }

  return {
    googleTrends: ensureTenItems(googleTrends, [...portalRetailTrends, ...fallbackNewsletterPool]),
    portalRetailTrends: ensureTenItems(portalRetailTrends, [...fallbackNewsletterPool, ...shortFormTrends]),
    shortFormTrends: ensureTenItems(shortFormTrends, [...fallbackNewsletterPool, ...portalRetailTrends]),
    newsletterTrends: ensureTenItems(fallbackNewsletterPool, [...portalRetailTrends, ...shortFormTrends])
  };
}

function createWorkObject({ id, typeId, keyword, company, url, rawText, scenario }) {
  const nowStr = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return {
    id: id || 'work-' + Date.now(),
    userId: 'user-1',
    title: scenario.titleCandidates[0].title,
    keyword,
    inputUrl: url || '',
    inputCompany: company || '',
    rawText: rawText || '',
    typeId: Number(typeId) || scenario.recommendedType || 2,
    createdAt: new Date().toISOString(),
    updatedAt: nowStr,
    geoChecks: GEO_CHECKLIST_ITEMS.map(item => ({ ...item, checked: true })),
    sources: scenario.sources,
    researchItems: scenario.researchItems,
    titleCandidates: scenario.titleCandidates,
    selectedTitleId: scenario.selectedTitleId,
    draftSections: scenario.draftSections,
    summaryBlocks: scenario.summaryBlocks,
    factChecks: scenario.factChecks
  };
}

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    const s1 = buildPresetScenario({ keyword: '10월 10일 임산부의 날', selectedType: 2 });
    const s2 = buildPresetScenario({ keyword: '결혼 트렌드', company: '오늘의집', url: 'https://www.ohou.se/exhibitions/wedding', selectedType: 1 });
    const initialDb = {
      works: [
        createWorkObject({
          id: 'work-sample-1',
          typeId: 2,
          keyword: '10월 10일 임산부의 날',
          company: '매일유업·유한킴벌리 등',
          url: '',
          scenario: s1
        }),
        createWorkObject({
          id: 'work-sample-2',
          typeId: 1,
          keyword: '결혼 트렌드',
          company: '오늘의집·번개장터',
          url: 'https://www.ohou.se/exhibitions/wedding',
          scenario: s2
        })
      ]
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initialDb, null, 2), 'utf8');
  } else {
    // 기존 DB에 타 언론사 기사 제목이 그대로 들어간 작업(예: 과일모찌)이 있으면 매경 자체 문장으로 자동 교정
    try {
      const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      let modified = false;
      (db.works || []).forEach(w => {
        if (!w.geoChecks) {
          w.geoChecks = GEO_CHECKLIST_ITEMS.map(item => ({ ...item, checked: true }));
          modified = true;
        }
        if (w.keyword === '과일모찌' && JSON.stringify(w.draftSections).includes('[가보니]')) {
          const cleanScenario = buildDynamicWorkFromNews({
            keyword: '과일모찌',
            company: w.inputCompany || '',
            url: w.inputUrl || '',
            rawText: w.rawText || '',
            typeId: w.typeId || 4,
            newsItems: [
              { title: "하루 150개 한정 과일모찌 새벽 대기열 및 떡 디저트 열풍", source: '업계 동향', link: 'https://www.mk.co.kr', pubDateShort: '2026-10-19' },
              { title: "찹쌀떡 전문점 1시간 웨이팅 및 영춘모찌·한정선 인기", source: '유통가 동향', link: 'https://www.mk.co.kr', pubDateShort: '2026-10-18' },
              { title: "롯데백화점 대구점 여수 과일모찌 전문 브랜드 서녹씨 입점", source: '유통업계', link: 'https://www.mk.co.kr', pubDateShort: '2026-10-01' }
            ]
          });
          w.researchItems = cleanScenario.researchItems;
          w.draftSections = cleanScenario.draftSections;
          w.summaryBlocks = cleanScenario.summaryBlocks;
          w.factChecks = cleanScenario.factChecks;
          modified = true;
        }
      });
      if (modified) {
        fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
      }
    } catch (e) {
      console.error('DB migration warning:', e.message);
    }
  }
}

const ENV_JSON_PATH = path.join(DATA_DIR, '.env.json');

function readDb() {
  ensureDb();
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  db.config = db.config || {};
  if (fs.existsSync(ENV_JSON_PATH)) {
    try {
      const envCfg = JSON.parse(fs.readFileSync(ENV_JSON_PATH, 'utf8'));
      if (envCfg.perplexityApiKey) {
        db.config.perplexityApiKey = envCfg.perplexityApiKey;
      }
    } catch (e) {
      // ignore
    }
  }
  const envKey = (process.env.PERPLEXITY_API_KEY || process.env.PPLX_API_KEY || '').trim();
  if (envKey && !db.config.perplexityApiKey) {
    db.config.perplexityApiKey = envKey;
  }
  return db;
}

function writeDb(db) {
  const copy = JSON.parse(JSON.stringify(db));
  if (copy.config && copy.config.perplexityApiKey !== undefined) {
    try {
      fs.writeFileSync(
        ENV_JSON_PATH,
        JSON.stringify({ perplexityApiKey: copy.config.perplexityApiKey }, null, 2),
        'utf8'
      );
    } catch (e) {
      // ignore
    }
    copy.config.perplexityApiKey = '';
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(copy, null, 2), 'utf8');
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

const requestHandler = async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers?.host || 'localhost'}`);
  const pathname = parsedUrl.pathname.replace(/^\/\.netlify\/functions\/api/, '/api');

  try {
    // 0. Perplexity API 키 설정 및 실시간 API 버닝(사용량·과금) 상태 조회 (/api/config)
    if (pathname === '/api/config' && req.method === 'GET') {
      const db = readDb();
      const key = db.config?.perplexityApiKey || '';
      return sendJson(res, 200, {
        hasPerplexityKey: Boolean(key),
        maskedKey: key ? `${key.slice(0, 8)}...${key.slice(-4)}` : '',
        apiUsageStats
      });
    }

    if (pathname === '/api/config' && req.method === 'POST') {
      const body = await parseBody(req);
      const db = readDb();
      const rawKey = (body.perplexityApiKey || '').trim();
      db.config = db.config || {};
      db.config.perplexityApiKey = rawKey;
      writeDb(db);
      cachedTrendRadar = null;
      cachedTrendTimestamp = 0;
      return sendJson(res, 200, {
        ok: true,
        hasPerplexityKey: Boolean(rawKey),
        maskedKey: rawKey ? `${rawKey.slice(0, 8)}...${rawKey.slice(-4)}` : '',
        apiUsageStats
      });
    }

    // 1. 실시간 트렌드 레이더 API (30분 스마트 캐시 적용으로 단순 웹 접속·F5 새로고침 시 API 중복 버닝 원천 차단!)
    if (pathname === '/api/trends' && req.method === 'GET') {
      const db = readDb();
      const apiKey = db.config?.perplexityApiKey || '';
      const explicitRefresh = parsedUrl.searchParams.get('refresh') === '1';
      const now = Date.now();

      if (!explicitRefresh && cachedTrendRadar && now - cachedTrendTimestamp < TREND_CACHE_TTL_MS) {
        apiUsageStats.cacheHitsOnRefresh += 1;
        return sendJson(res, 200, {
          ...cachedTrendRadar,
          fromCache: true,
          apiUsageStats
        });
      }

      const forcePplx = Boolean(apiKey);
      const radar = await fetchLiveTrendRadar(apiKey, forcePplx);
      cachedTrendRadar = radar;
      cachedTrendTimestamp = now;
      return sendJson(res, 200, {
        ...radar,
        fromCache: false,
        apiUsageStats
      });
    }

    // 2. 실시간 뉴스 검색 API
    if (pathname === '/api/live-search' && req.method === 'GET') {
      const q = parsedUrl.searchParams.get('q') || '';
      const newsItems = await fetchRealTimeKoreanNews(q, 6);
      return sendJson(res, 200, { keyword: q, newsItems });
    }

    // 3. 작업 목록 조회
    if (pathname === '/api/works' && req.method === 'GET') {
      const db = readDb();
      return sendJson(res, 200, { works: db.works || [] });
    }

    // 4. 새 작업 생성
    if (pathname === '/api/works' && req.method === 'POST') {
      const body = await parseBody(req);
      const db = readDb();
      const apiKey = db.config?.perplexityApiKey || '';
      const mode = body.mode || 'dynamic';
      const keyword = (body.keyword || CONTENT_TYPES[Number(body.typeId) || 4]?.exampleKeyword || '최신 트렌드').trim();
      const company = (body.company || '').trim();
      const url = (body.url || '').trim();
      const rawText = (body.rawText || '').trim();
      const autoMatchType = Boolean(body.autoMatchType);
      const requestedType = Number(body.typeId) || 4;
      const typeId = autoMatchType ? detectBestContentType(keyword, company, rawText, requestedType) : requestedType;

      let scenario;
      let liveCount = 0;

      if (mode === 'example') {
        scenario = buildPresetScenario({ keyword, company, url, selectedType: typeId });
      } else {
        const searchQuery = company ? `${keyword} ${company}` : keyword;
        const [pressItems, shortsItems] = await Promise.all([
          fetchRealTimeKoreanNews(searchQuery, 5),
          fetchYouTubeShorts(searchQuery, 3)
        ]);
        const newsItems = [...pressItems, ...shortsItems];
        liveCount = newsItems.length;
        const baseScenario = buildDynamicWorkFromNews({
          keyword,
          company,
          url,
          rawText,
          typeId,
          newsItems
        });

        if (apiKey) {
          try {
            scenario = await buildPerplexityEnhancedScenario({
              apiKey,
              keyword,
              company,
              url,
              rawText,
              typeId,
              newsItems,
              baseScenario
            });
          } catch (pplxErr) {
            console.error('Perplexity draft error, using fallback:', pplxErr.message);
            scenario = baseScenario;
            scenario.pplxError = pplxErr.message;
          }
        } else {
          scenario = baseScenario;
        }
      }

      const newWork = createWorkObject({
        typeId,
        keyword,
        company,
        url,
        rawText,
        scenario
      });
      newWork.liveNewsCount = liveCount;
      newWork.usedPerplexity = Boolean(scenario.usedPerplexity);

      db.works.unshift(newWork);
      writeDb(db);
      return sendJson(res, 201, {
        work: newWork,
        liveNewsCount: liveCount,
        usedPerplexity: Boolean(scenario.usedPerplexity),
        pplxError: scenario.pplxError || ''
      });
    }

    // 5. 기존 작업 안에서 새 키워드로 실시간 뉴스 재수집 및 매경 문체 재가공 반영
    if (pathname.startsWith('/api/works/') && pathname.endsWith('/refresh-news') && req.method === 'POST') {
      const workId = pathname.replace('/api/works/', '').replace('/refresh-news', '');
      const body = await parseBody(req);
      const db = readDb();
      const apiKey = db.config?.perplexityApiKey || '';
      let idx = db.works.findIndex(w => w.id === workId);
      if (idx === -1) {
        const seedScenario = buildPresetScenario({
          keyword: (body.keyword || '최신 트렌드').trim(),
          company: (body.company || '').trim(),
          url: '',
          selectedType: Number(body.typeId) || 4
        });
        const newEntry = createWorkObject({
          id: workId,
          typeId: Number(body.typeId) || 4,
          keyword: (body.keyword || '최신 트렌드').trim(),
          company: (body.company || '').trim(),
          url: '',
          rawText: '',
          scenario: seedScenario
        });
        if (Array.isArray(body.existingSources)) newEntry.sources = body.existingSources;
        if (Array.isArray(body.existingResearchItems)) newEntry.researchItems = body.existingResearchItems;
        db.works.unshift(newEntry);
        idx = 0;
      }

      const current = db.works[idx];
      const keyword = (body.keyword || current.keyword).trim();
      const company = (body.company !== undefined ? body.company : current.inputCompany || '').trim();
      const url = (body.url !== undefined ? body.url : current.inputUrl || '').trim();
      const rawText = (body.rawText !== undefined ? body.rawText : current.rawText || '').trim();
      const autoMatch = Boolean(body.autoMatchType);
      const rawTypeId = Number(body.typeId || current.typeId || 4);
      const typeId = autoMatch ? detectBestContentType(keyword, company, rawText, rawTypeId) : rawTypeId;
      const rebuildDraft = Boolean(body.rebuildDraft);

      const searchQuery = company ? `${keyword} ${company}` : keyword;
      const [pressItems, shortsItems] = await Promise.all([
        fetchRealTimeKoreanNews(searchQuery, 5),
        fetchYouTubeShorts(searchQuery, 3)
      ]);
      const newsItems = [...pressItems, ...shortsItems];

      if (rebuildDraft) {
        const baseScenario = buildDynamicWorkFromNews({
          keyword,
          company,
          url,
          rawText,
          typeId,
          newsItems
        });
        let scenario = baseScenario;
        if (apiKey) {
          try {
            scenario = await buildPerplexityEnhancedScenario({
              apiKey,
              keyword,
              company,
              url,
              rawText,
              typeId,
              newsItems,
              baseScenario
            });
          } catch (pplxErr) {
            console.error('Perplexity refresh error:', pplxErr.message);
            scenario.pplxError = pplxErr.message;
          }
        }
        db.works[idx] = {
          ...current,
          keyword,
          inputCompany: company,
          inputUrl: url,
          rawText,
          typeId,
          title: scenario.titleCandidates[0].title,
          selectedTitleId: scenario.selectedTitleId,
          titleCandidates: scenario.titleCandidates,
          sources: scenario.sources,
          researchItems: scenario.researchItems,
          draftSections: scenario.draftSections,
          summaryBlocks: scenario.summaryBlocks,
          factChecks: scenario.factChecks,
          usedPerplexity: Boolean(scenario.usedPerplexity),
          updatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ')
        };
      } else {
        // 취재 메모장에도 타 언론사 문장 그대로가 아닌 '매경 문체 재가공 팩트'로 추가
        newsItems.forEach((n, i) => {
          const srcId = `src-add-${Date.now()}-${i}`;
          const reworked = paraphraseNewsToMkFact(n.title, keyword, n.source, i);
          current.sources.unshift({
            id: srcId,
            url: n.link,
            title: `[참고 보도 · ${n.source}] ${n.title}`,
            method: '실시간 트렌드 수집',
            reliability: '높음'
          });
          current.researchItems.unshift({
            id: `ri-add-${Date.now()}-${i}`,
            category: `추출 팩트 (${reworked.extractedNumbers !== '주요 지표 확인' ? reworked.extractedNumbers : n.pubDateShort || '최신'})`,
            fact: reworked.paraphrasedSentence,
            rawReference: `참고 보도 주제: ${n.title} (${n.source})`,
            sourceIds: [srcId]
          });
        });
        current.keyword = keyword;
        current.updatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
      }

      writeDb(db);
      return sendJson(res, 200, { work: db.works[idx], liveNewsCount: newsItems.length });
    }

    // 6. 작업 저장 / 업데이트
    if (pathname.startsWith('/api/works/') && req.method === 'PUT') {
      const workId = pathname.replace('/api/works/', '');
      const body = await parseBody(req);
      const db = readDb();
      const idx = db.works.findIndex(w => w.id === workId);
      if (idx === -1) return sendJson(res, 404, { error: '작업을 찾을 수 없습니다.' });

      const nowStr = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const existingStatusMap = new Map(
        (body.factChecks || db.works[idx].factChecks || []).map(f => [f.sentence, f.status])
      );
      const autoFacts = extractFactSentencesFromSections(
        body.draftSections || db.works[idx].draftSections,
        body.sources || db.works[idx].sources
      ).map(fc => ({
        ...fc,
        status: existingStatusMap.get(fc.sentence) || fc.status
      }));

      db.works[idx] = {
        ...db.works[idx],
        ...body,
        factChecks: body.factChecks || autoFacts,
        updatedAt: nowStr
      };
      writeDb(db);
      return sendJson(res, 200, { work: db.works[idx] });
    }

    // 7. 작업 삭제
    if (pathname.startsWith('/api/works/') && req.method === 'DELETE') {
      const workId = pathname.replace('/api/works/', '');
      const db = readDb();
      db.works = db.works.filter(w => w.id !== workId);
      writeDb(db);
      return sendJson(res, 200, { ok: true });
    }

    // 8. 정적 파일 서빙
    let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const headers = {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      };
      if (ext === '.pdf') {
        headers['Content-Disposition'] = `inline; filename="${path.basename(filePath)}"`;
      }
      res.writeHead(200, headers);
      return fs.createReadStream(filePath).pipe(res);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message || '서버 오류가 발생했습니다.' });
  }
};

const server = http.createServer(requestHandler);

if (require.main === module) {
  ensureDb();
  server.listen(PORT, () => {
    console.log(`MK Pick 콘텐츠 스튜디오 서버가 실행 중입니다: http://localhost:${PORT}`);
  });
}

module.exports = { requestHandler, ensureDb };
