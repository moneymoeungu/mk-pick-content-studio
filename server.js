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
  isVirtualIdolQuery,
  getVirtualIdolScenario,
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

// Perplexity API를 활용해 선택한 콘텐츠 유형(1~5번) 및 실제 MK Pick 에디터 문법(타임라인 + 소재별 1:1 스포트라이트 + Bonus Track + 5열 비교표 + 용어사전 + 수미상관 에필로그)에 맞춘 기사 초안 생성
async function buildPerplexityEnhancedScenario({ apiKey, keyword, company, url, rawText, typeId, newsItems, baseScenario }) {
  // 버츄얼 아이돌 계보 키워드('아담, 키즈나아이, 이세계아이돌, 플레이브, 나이비스' 등)인 경우 실제 MK Pick 에디터 원고 시나리오를 최우선 보존
  if (isVirtualIdolQuery(keyword, company)) {
    const viScenario = getVirtualIdolScenario(keyword);
    return {
      ...viScenario,
      usedPerplexity: true
    };
  }

  const tInfo = CONTENT_TYPES[typeId] || CONTENT_TYPES[4];
  const newsContext = (newsItems || [])
    .slice(0, 6)
    .map((n, i) => `${i + 1}. [${n.source}] ${n.title} (${n.link})`)
    .join('\n');

  const kwEntities = String(keyword || '')
    .split(/[,/·]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const isMultiEntityTopic = kwEntities.length >= 2;

  const typeInstructions = {
    1: '유형 1(유료 업체 타겟팅 기획 콘텐츠): 1단락은 과거 일괄 방식 vs 현재 맞춤형 시대별 변화 비교(탄생 배경과 이유 / 달라진 점 라벨 활용), 이후 단락들은 타깃 파트너사 및 주요 기업 3~4곳을 각각 독립 단락("기업명 ‘핵심 서비스 한 줄 정의’")으로 하나씩 심층 소개, 마지막 단락은 실패 없는 선택 기준. 요약표는 5열 비교표, 용어 사전 4~5개, FAQ는 7문항.',
    2: '유형 2(특정 기념일 관련 콘텐츠): 1단락은 기념일 유래·법적 지정 배경, 2단락은 정부·지자체 공식 지원 제도 및 바우처, 이후 단락들은 이 기념일을 맞아 참여하는 주요 브랜드 3~5곳을 각각 독립 단락 또는 "■ [브랜드명] 캠페인·제품·마케팅명" 소항목으로 하나씩 구체적으로 소개. 요약표는 브랜드별 5열 비교표, 용어 사전 4~5개, FAQ는 5문항.',
    3: '유형 3(최신 트렌드 반영 콘텐츠 1 - 시대별 타임라인 계보 & 대표 주자 1:1 심층 조명): 실제 MK Pick 에디터의 버츄얼 아이돌 기사 문법을 그대로 적용할 것! 1~2단락은 초창기 원조 개척자부터 전환기를 거쳐 현재 전성기에 이르기까지의 시대별 타임라인("연도/시기 : 소재명 ‘한 줄 정의’" 소제목 + 본문 내 "탄생 배경과 이유 :", "활동 방식의 한계 :", "달라진 점 :" 소항목 라벨 포함), 이어지는 3~6단락은 현재 시장을 이끄는 대표 주자 3~4곳(사용자가 입력한 복수 소재 + 최신 연관 신예 1곳 포함)을 절대 한 단락에 뭉뚱그리지 말고 하나씩 독립 단락("주자명 (영문) ‘핵심 상징 한 줄 정의’")으로 쪼개어 서사·성과·콜라보를 심층 소개, 마지막 단락은 "Bonus Track : ..."으로 유쾌한 외전·밈(Meme) 사례 소개. 요약표는 5열 상세 비교표(구분 | 유형 및 구성원 | 탄생 배경 및 특징 | 주요 성과 | 팬덤 및 주요 협업(연도 포함)), 용어 사전 5개, FAQ 5문항, 수미상관 마무리 에필로그 문단 필수.',
    4: '유형 4(최신 트렌드 반영 콘텐츠 2 - 신제품 출시·팝업을 거시적 마케팅 키워드로 재정의): 1단락은 감성적 질문 리드와 거시적 마케팅 콘셉트 도출("탄생 배경과 이유 :", "달라진 점 :" 포함), 2~5단락은 주요 브랜드·유통 채널별 대표 라인업 3~4곳을 하나씩 독립 단락("브랜드·제품명 ‘차별화 포인트 한 줄 정의’")으로 심층 소개, 마지막 단락은 "Bonus Track" 또는 품절 대란 속 구매·오픈런 팁 소개. 요약표는 5열 비교표, 용어 사전 4~5개, FAQ는 5문항.',
    5: '유형 5(영업 기업 맞춤 기획 콘텐츠): 1단락은 독자 질문 도입 1문단 뒤 Q1~Q4 시장 메가 트렌드·소비자 페인포인트 문답, 2단락은 Q5~Q6 선택 기준 문답, 3단락은 Q7에서 영업 타깃 기업의 핵심 솔루션·경쟁력을 집중 소개. 요약표는 대상 기업 핵심 기능·기대효과 5열 요약표, 용어 사전 4~5개, FAQ는 7문항.'
  };

  const faqCount = (typeId === 1 || typeId === 5) ? 7 : 5;
  const fallbackCat = recommendMkPickCategory(keyword, typeId, company);
  const sys = `당신은 매일경제 MK Pick(GEO·AEO 최적화 매거진형 심층 기사) 수석 에디터입니다.
타 언론사 기사의 문장을 절대 그대로 베끼지 말고, 수치·브랜드명·멤버명·콜라보 연도 등 핵심 팩트만 추출하여 모든 본문과 답변을 매일경제 고유의 정중하고 생동감 있는 "~합니다/습니다" 체로 작성하세요.

[실제 MK Pick 에디터의 글쓰기 6대 핵심 공식 — 반드시 준수!]
1. 감성적·시대적 도입 리드문:
   - 첫 번째 단락(draftSections[0].content)의 첫 문장은 건조한 보고서 문장이 아니라, 독자의 향수나 호기심을 자극하는 생생한 장면 묘사형 질문(예: "플로피디스크가 돌아가던 1998년, 3D 그래픽의 초창기에 홀로 외롭게 노래했던 ‘사이버 가수’를 기억하시나요? 그로부터 수십 년 뒤, 음원 차트 최상위권을 휩쓸며 대기업 광고판을 점령한 ‘...’의 시대가 열렸습니다.")으로 시작하세요.
   - 이어서 두 번째 문단에서 이 기사가 어디서부터 어디까지(정통 주자부터 유쾌한 외전까지) 다루는지 흥미진진한 타임라인 가이드를 제시하세요.
2. 본문 내 가독성 라벨("항목명 :") 적극 활용:
   - 시대별 배경이나 분석 단락 본문 안에는 "탄생 배경과 이유 : ...", "활동 방식의 한계 : ...", "달라진 점 : ...", "독창적 콘셉트 : ..."처럼 소항목 라벨을 붙여 독자가 긴 글도 술술 읽을 수 있게 구성하세요.
3. 하나의 주제에 여러 소재/그룹/브랜드가 나오면 반드시 '하나씩 독립 단락'으로 쪼개어 소개 (최소 5~7개 단락 생성!):
   - 절대 3개 단락 안에 모든 소재를 뭉뚱그려 넣거나, 생뚱맞은 B2B 계약서·업체 선정 매뉴얼 톤으로 끝내지 마세요!
   - 사용자가 여러 키워드(${isMultiEntityTopic ? kwEntities.join(', ') : '관련 대표 주자들'})를 입력했거나 하나의 트렌드에 여러 대표 주자가 있다면, 시대별 흐름 단락 뒤에 각 대표 주자(3~4곳, 입력 키워드 외 최신 주목받는 신예 1곳 추가 가능)를 각각 독립된 단락(draftSections)으로 분리하세요.
   - 각 소재 소개 단락의 소제목(title)은 기계적인 의문문 대신 실제 에디터처럼 "이세계아이돌 (ISEGYE IDOL) ‘스트리머 팬덤 경제’와 음원 파워의 상징", "플레이브 (PLAVE) ‘메인스트림 진입과 대중성’의 신기원", "1998년 : 사이버 가수 ‘아담’ 시대를 너무 앞서간 3D 개척자"처럼 [연도/대상명 + ‘핵심 상징 한 줄 정의’] 스타일로 힘 있게 작성하세요.
   - 마지막 본문 단락은 "Bonus Track : ..." 소제목으로 해당 트렌드와 연결되는 유쾌한 밈(Meme)이나 흥미로운 프리퀄·외전 사례를 1단락 소개하세요.
4. 고밀도 5열 비교 요약표(summaryTable):
   - 표 헤더는 ["구분", "유형 및 구성(멤버/라인업)", "탄생 배경 및 특징", "주요 성과·기록", "팬덤 및 주요 협업(브랜드·연도)"] 5열 구조로 작성하고, 각 셀에는 실제 멤버 실명, 지상파 1위/판매량 기록, 실제 협업한 대기업 브랜드명과 연도(예: 두찜 2023·2025년, 메디힐 2024년, 칠성사이다·할리스 2024년 등)를 구체적으로 기입하세요.
5. 주제를 더 깊이 이해하는 핵심 용어 사전(glossary) 5개 필수 포함:
   - 기사에 등장하는 핵심 기술·트렌드·문화 용어 5개를 선정해 명쾌한 "~합니다/습니다" 체 정의(glossary 배열)로 정리하세요.
6. 수미상관 마무리 에필로그 문단(closingParagraph) + 한 줄 요약(oneLineSummary):
   - 기사 맨 끝에는 첫 단락의 초창기 도전과 현재 주역들의 활약을 수미상관으로 엮어 감동과 여운을 남기는 2~3문장 에필로그(closingParagraph)를 작성하고, 마지막을 '한 줄 요약! “...” 앞으로 이들이 써 내려갈 새로운 역사가 더욱 기대되는 이유입니다.' 형태로 매듭지으세요.
   - 절대로 본문이나 FAQ에 "검색된 자료만으로는 확인되지 않는다" 같은 AI 메타 해명 문구를 넣지 마세요. 순수 JSON 객체만 출력하세요.`;

  const usr = `[작성 요청 정보]
- 키워드/주제: ${keyword}
- 타깃 기업/브랜드(선택): ${company || '관련 대표 주자·브랜드'}
- 참고 URL: ${url || '없음'}
- 추가 보도자료/메모: ${rawText || '없음'}
- 선택된 콘텐츠 유형: ${tInfo.shortName} (${tInfo.desc})
- 유형별 필수 구성 지침: ${typeInstructions[typeId] || typeInstructions[3]}
- 실시간 참고 뉴스/쇼츠 목록:
${newsContext || '실시간 웹 검색 결과를 바탕으로 최신 팩트 반영'}

아래 JSON 스키마에 맞춰 실제 MK Pick 에디터가 작성한 것처럼 깊이 있고 풍부한 분량(단락 5~7개, 5열 비교표, 용어 사전 5개, FAQ ${faqCount}개, 수미상관 에필로그)으로 작성하세요:
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
      "title": "시대·배경 소제목 (예: 1998년 : 사이버 가수 ‘아담’ 시대를 너무 앞서간 3D 개척자)",
      "content": "감성적 질문형 리드문 2문단 + '탄생 배경과 이유 : ...' 및 '활동 방식의 한계 : ...' 등 구체적 수치·스토리 2~3문단 (~합니다 체)",
      "imageCaption": "< 출처 : 관련 기업·아카이브 >"
    },
    {
      "id": "sec-2",
      "title": "전환기 및 전성기 소제목 (예: 2010~2020년대 : 쌍방향 소통과 기술이 연 본격 전성기)",
      "content": "'달라진 점 : ...' 라벨을 포함한 진화 과정 및 대표 주자 소개로 넘어가는 브릿지 질문 (~합니다 체)",
      "imageCaption": "< 출처 : 관련 기관·소속사 >"
    },
    {
      "id": "sec-3",
      "title": "대표 주자 1 이름 ‘핵심 상징 한 줄 정의’",
      "content": "첫 번째 대표 소재/그룹/브랜드의 탄생 배경, 팬덤, 구체적 차트·매출 성과, 대기업 콜라보 사례 상세 서술 (~합니다 체)",
      "imageCaption": "< 출처 : 공식 채널 >"
    },
    {
      "id": "sec-4",
      "title": "대표 주자 2 이름 ‘핵심 상징 한 줄 정의’",
      "content": "두 번째 대표 소재/그룹/브랜드의 차별점과 핵심 이정표(1위 기록, 브랜드 모델 발탁 등) 상세 서술 (~합니다 체)",
      "imageCaption": "< 출처 : 공식 채널 >"
    },
    {
      "id": "sec-5",
      "title": "대표 주자 3 이름 ‘핵심 상징 한 줄 정의’",
      "content": "세 번째 대표 소재/그룹/브랜드 및 주목할 만한 신예 주자의 세계관·특징 상세 서술 (~합니다 체)",
      "imageCaption": "< 출처 : 공식 채널 >"
    },
    {
      "id": "sec-6",
      "title": "Bonus Track : 유쾌한 외전 또는 밈(Meme) 주역 소개",
      "content": "'독창적 콘셉트 : ...' 라벨을 활용해 주제와 연결되는 흥미로운 외전·부캐·밈 사례 소개 (~합니다 체)",
      "imageCaption": "< 출처 : 공식 인스타그램·유튜브 >"
    }
  ],
  "summaryTable": {
    "title": "[ 대표 주자 핵심 비교 ]",
    "headers": ["구분", "유형 및 구성", "탄생 배경 및 특징", "주요 성과", "팬덤 및 주요 협업"],
    "rows": [
      ["주자 1", "구체적 형태·멤버", "탄생 배경 요약", "핵심 기록·성과", "대표 브랜드 콜라보(연도 포함)"],
      ["주자 2", "구체적 형태·멤버", "탄생 배경 요약", "핵심 기록·성과", "대표 브랜드 콜라보(연도 포함)"],
      ["주자 3", "구체적 형태·멤버", "탄생 배경 요약", "핵심 기록·성과", "대표 브랜드 콜라보(연도 포함)"],
      ["주자 4", "구체적 형태·멤버", "탄생 배경 요약", "핵심 기록·성과", "대표 브랜드 콜라보(연도 포함)"]
    ]
  },
  "glossaryTitle": "주제를 더 깊이 이해하는 용어 사전",
  "glossary": [
    {"term": "핵심 용어 1 (영문)", "desc": "누구나 이해하기 쉬운 1~2문장 개념 해설 (~합니다 체)"},
    {"term": "핵심 용어 2 (영문)", "desc": "누구나 이해하기 쉬운 1~2문장 개념 해설 (~합니다 체)"},
    {"term": "핵심 용어 3 (영문)", "desc": "누구나 이해하기 쉬운 1~2문장 개념 해설 (~합니다 체)"},
    {"term": "핵심 용어 4 (영문)", "desc": "누구나 이해하기 쉬운 1~2문장 개념 해설 (~합니다 체)"},
    {"term": "핵심 용어 5 (영문)", "desc": "누구나 이해하기 쉬운 1~2문장 개념 해설 (~합니다 체)"}
  ],
  "faqs": [
    {"q": "Q1. 사람들이 실제로 검색창에 물어볼 법한 구어체 자연어 질문 (~나요? / ~무엇인가요?)", "a": "구체적인 수치·연도·고유명사가 담긴 2~3문장 완결형 답변 (~합니다 체)"}
  ],
  "fanoutQuestions": [
    {"category": "예약·대기", "q": "연관 자연어 질문 1", "a": "구체적인 답변 (~합니다 체)"},
    {"category": "가격·혜택", "q": "연관 자연어 질문 2", "a": "구체적인 답변 (~합니다 체)"},
    {"category": "위치·교통", "q": "연관 자연어 질문 3", "a": "구체적인 답변 (~합니다 체)"},
    {"category": "구매·수량제한", "q": "연관 자연어 질문 4", "a": "구체적인 답변 (~합니다 체)"},
    {"category": "동반·선물팁", "q": "연관 자연어 질문 5", "a": "구체적인 답변 (~합니다 체)"},
    {"category": "차별점·비교", "q": "연관 자연어 질문 6", "a": "구체적인 답변 (~합니다 체)"},
    {"category": "온라인·앱연동", "q": "연관 자연어 질문 7", "a": "구체적인 답변 (~합니다 체)"},
    {"category": "후속일정·주의사항", "q": "연관 자연어 질문 8", "a": "구체적인 답변 (~합니다 체)"}
  ],
  "closingParagraph": "초창기 주역의 도전부터 현재 대표 주자들의 무대까지 수미상관으로 엮어 감동과 여운을 남기는 마무리 총평 2~3문장 (~합니다 체)",
  "oneLineSummary": "한 줄 요약! “핵심 통찰 인용구” 앞으로 이들이 써 내려갈 새로운 역사가 더욱 기대되는 이유입니다."
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
        imageCaption: sec.imageCaption || '',
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
    glossaryTitle: parsed.glossaryTitle || baseScenario.summaryBlocks.glossaryTitle || '주제를 더 깊이 이해하는 용어 사전',
    glossary: Array.isArray(parsed.glossary) && parsed.glossary.length > 0
      ? parsed.glossary.map(g => ({
          term: (g.term || '').trim(),
          desc: (g.desc || '').trim()
        })).filter(g => g.term && g.desc)
      : (baseScenario.summaryBlocks.glossary || []),
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
    closingParagraph: parsed.closingParagraph || baseScenario.summaryBlocks.closingParagraph || '',
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
      const autoMatchType = Boolean(body.autoMatchType) || isVirtualIdolQuery(keyword, company) || keyword.split(',').length >= 3;
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
      const autoMatch = Boolean(body.autoMatchType) || isVirtualIdolQuery(keyword, company) || keyword.split(',').length >= 3 || keyword !== current.keyword;
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
