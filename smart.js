// Smart folders: unread articles grouped by language, broad topic, and what
// the feed tells us about them (videos, podcasts, long reads, opinion…).
// Everything is worked out on this device from the article and its feed.

export const LANGS = {
  en: 'English', fr: 'French', ar: 'Arabic', fa: 'Persian', ru: 'Russian', uk: 'Ukrainian', hy: 'Armenian',
  ka: 'Georgian', tr: 'Turkish', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese', nl: 'Dutch',
  he: 'Hebrew', el: 'Greek', hi: 'Hindi', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ur: 'Urdu', az: 'Azerbaijani',
};

// Common short words of each language written in Latin letters.
const STOP = {
  en: 'the and of to in is that for on with are was this from by at be have it as an not you we they has will',
  fr: 'le la les des est une et du pour que dans qui sur pas au aux avec ce cette sont par plus ont été mais leur',
  es: 'el los las del una que por con para es en se su al como más pero sus fue este esta han sido muy entre',
  de: 'der die das und ist nicht mit den von zu ein eine auf für sich dem des im auch wird sind bei nach oder',
  it: 'il di che la per non una sono con gli del della nel alla anche come più dei ha questo questa essere',
  pt: 'que não uma com para os das dos por mais como foi pelo pela são ao seu sua também está em ser tem',
  nl: 'de het een en van is dat niet op te zijn met voor ook aan er maar als bij om wordt door naar heeft',
  tr: 've bir bu da de için ile çok daha olarak gibi ama olan en sonra kadar ancak değil var yeni göre',
  az: 'və bir bu ki ilə üçün da də olan daha çox sonra artıq görə edib edir olub ancaq lakin həm',
};
const STOP_SETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v.split(' '))]));

const SCRIPTS = [
  ['hy', /\p{Script=Armenian}/gu], ['ka', /\p{Script=Georgian}/gu], ['he', /\p{Script=Hebrew}/gu],
  ['el', /\p{Script=Greek}/gu], ['hi', /\p{Script=Devanagari}/gu], ['ko', /\p{Script=Hangul}/gu],
  ['ja', /[\p{Script=Hiragana}\p{Script=Katakana}]/gu], ['zh', /\p{Script=Han}/gu],
  ['ar', /\p{Script=Arabic}/gu], ['ru', /\p{Script=Cyrillic}/gu],
];

/** The language of a piece of text ('' if it can't tell), with the feed's declared language as a hint. */
export function detectLang(text, feedLang = '') {
  const hint = (feedLang || '').toLowerCase().slice(0, 2);
  const letters = (text.match(/\p{L}/gu) || []).length;
  if (!letters) return LANGS[hint] ? hint : '';
  for (const [code, re] of SCRIPTS) {
    const n = (text.match(re) || []).length;
    if (n < letters * 0.3) continue;
    if (code === 'ar') {
      if (/[پچژگ]/.test(text)) return hint === 'ur' ? 'ur' : 'fa';
      return hint === 'fa' || hint === 'ur' ? hint : 'ar';
    }
    if (code === 'ru') return /[іїєґ]/i.test(text) || hint === 'uk' ? 'uk' : 'ru';
    if (code === 'zh') return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) ? 'ja' : 'zh';
    return code;
  }
  // Latin letters: count each language's common words.
  const words = text.toLowerCase().match(/[\p{L}']+/gu) || [];
  const scores = {};
  for (const w of words) for (const [code, set] of Object.entries(STOP_SETS)) if (set.has(w)) scores[code] = (scores[code] || 0) + 1;
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (best && best[1] >= 2 && (!second || best[1] >= second[1] * 1.5)) return best[0];
  if (LANGS[hint]) return hint;
  return best && best[1] >= 1 && (!second || best[1] > second[1]) ? best[0] : '';
}

// Broad topics. Words match at word starts, so "elect" catches "election" and "elected".
// A few words in French, Arabic, Persian and Russian so other languages land in topics too.
export const TOPICS = [
  { id: 'politics', name: 'Politics', icon: '🏛️', folder: /politic|government|elections?/i,
    words: 'politic election elected parliament senate senator congress congressman president presidential prime_minister government govt vote voters ballot campaign democrat republican referendum coalition opposition lawmaker legislat diplomat diplomacy sanction cabinet kremlin white_house downing_street trump biden harris putin zelensky pashinyan aliyev erdogan netanyahu macron starmer khamenei pezeshkian élection gouvernement ministre président parlement انتخابات حكومة الرئيس وزير برلمان مجلس دولت انتخابات مجلس وزیر رئیس‌جمهور выбор правительств президент парламент министр' },
  { id: 'conflict', name: 'Conflict & security', icon: '⚔️', folder: /conflict|war|defen[cs]e|military/i,
    words: 'war wars military army troops soldier missile airstrike air_strike drone strike ceasefire cease-fire invasion militant militia hostage shelling artillery frontline front_line nato pentagon idf hamas hezbollah houthi insurgent guerre armée حرب الجيش قصف صاروخ هدنة جنگ ارتش موشک война армия ракет удар' },
  { id: 'business', name: 'Business & money', icon: '💼', folder: /business|finance|money|econom|market/i,
    words: 'econom market stock stocks shares investor invest earnings revenue profit ipo inflation interest_rate rates central_bank fed federal_reserve gdp recession tariff trade deficit merger acquisition acquire startup funding valuation layoff layoffs ceo nasdaq dow s&p oil_price prices opec bourse économie اقتصاد بورصة أسعار النفط اقتصاد بورس قیمت экономик рынок инфляц' },
  { id: 'tech', name: 'Tech', icon: '💻', folder: /tech|gadget|apple|android|mac\b|ios\b|linux|hardware|software/i,
    words: 'tech technology apple iphone ipad mac macos ios android google microsoft windows samsung pixel smartphone phone laptop tablet chip chips semiconductor nvidia intel amd qualcomm gadget software app apps update browser chrome firefox cloud hardware wearable smartwatch headphones tesla spacex meta amazon tiktok twitter x.com telegram whatsapp وادي_السيليكون تقنية فناوری технолог' },
  { id: 'ai', name: 'AI', icon: '🤖', folder: /\bai\b|artificial_intelligence|machine_learning/i,
    words: 'ai artificial_intelligence machine_learning deep_learning neural llm llms chatgpt openai anthropic claude gemini copilot gpt chatbot chatbots generative deepmind mistral llama midjourney agentic agents intelligence_artificielle الذكاء_الاصطناعي هوش_مصنوعی искусственн нейросет' },
  { id: 'crypto', name: 'Crypto', icon: '🪙', folder: /crypto|bitcoin|blockchain/i,
    words: 'bitcoin btc ethereum eth crypto cryptocurrency cryptocurrencies blockchain stablecoin stablecoins nft nfts defi solana binance coinbase altcoin altcoins satoshi web3 dogecoin xrp ripple tether usdt halving بيتكوين العملات_المشفرة بیت‌کوین رمزارز биткоин криптовалют' },
  { id: 'science', name: 'Science & space', icon: '🔬', folder: /scien|space|astronom|physics/i,
    words: 'science scientist scientists research researchers study_finds physics physicist astronomy astronomer nasa esa space telescope planet planets galaxy asteroid comet mars moon lunar rocket orbit species fossil dinosaur quantum biology chemistry genome dna evolution archaeolog علماء الفضاء دراسة دانشمندان фізик учёные космос' },
  { id: 'health', name: 'Health', icon: '🩺', folder: /health|medic|fitness|wellness/i,
    words: 'health healthcare disease vaccine vaccines cancer hospital hospitals virus covid pandemic outbreak medical medicine drug drugs fda who patients doctor doctors nurse mental_health obesity diabetes alzheimer heart_attack nutrition diet santé الصحة مستشفى لقاح سلامت بیمارستان здоровь больниц вакцин' },
  { id: 'climate', name: 'Climate & environment', icon: '🌱', folder: /climate|environment|green|energy/i,
    words: 'climate emissions carbon co2 renewable renewables solar wind_power wildfire wildfires drought flood floods flooding heatwave heat_wave hurricane typhoon earthquake environment environmental pollution deforestation fossil_fuel fuels net_zero cop29 cop30 climat المناخ زلزال فيضانات آب‌وهوا زلزله климат' },
  { id: 'security', name: 'Cybersecurity', icon: '🔒', folder: /secur|privacy|infosec|hack/i,
    words: 'hack hacked hacker hackers hacking breach breaches ransomware malware vulnerability vulnerabilities exploit exploited cve phishing cyberattack cyber_attack cybersecurity zero-day spyware botnet ddos backdoor infostealer data_leak password passwords encryption privacy' },
  { id: 'sport', name: 'Sport', icon: '⚽', folder: /sport|football|soccer|nba|nfl|f1/i,
    words: 'football soccer nba nfl mlb nhl match league championship tennis olympic olympics fifa uefa premier_league champions_league world_cup tournament coach goalkeeper striker formula_1 f1 grand_prix cricket rugby boxing ufc marathon كرة_القدم المنتخب دوري فوتبال لیگ футбол матч чемпионат' },
  { id: 'games', name: 'Games', icon: '🎮', folder: /gam(e|ing)|playstation|xbox|nintendo/i,
    words: 'game games gaming gamer gamers playstation ps5 xbox nintendo switch steam esports console consoles videogame video_game minecraft fortnite' },
  { id: 'culture', name: 'Culture & entertainment', icon: '🎬', folder: /culture|entertain|movie|film|music|books?|arts?\b|tv\b/i,
    words: 'film films movie movies tv series show netflix hbo disney hollywood music album song songs singer band concert celebrity actor actress oscar oscars grammy festival book books novel author art artist museum exhibition theatre theater cinéma musique سينما فيلم موسيقى سینما فیلم موسیقی фильм кино музык' },
  { id: 'programming', name: 'Programming', icon: '👩‍💻', folder: /program|code|coding|developer|dev\b|web ?dev/i,
    words: 'programming programmer code coding developer developers javascript typescript python rust golang java kotlin swift github gitlab open_source open-source api apis framework compiler database sql postgres react node.js npm css html webassembly kubernetes docker' },
];

const escRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LATINISH = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}&]/u;
// Words are space-separated; "_" joins the words of a phrase ("prime_minister").
for (const t of TOPICS) {
  const words = [...new Set(t.words.split(/\s+/).filter(Boolean))];
  const pat = (w) => escRe(w).replace(/_/g, '\\s+');
  const spaced = words.filter((w) => LATINISH.test(w)).map(pat);
  const other = words.filter((w) => !LATINISH.test(w)).map(pat);
  const parts = [];
  if (spaced.length) parts.push(`(?<![\\p{L}\\p{N}])(?:${spaced.join('|')})`);
  if (other.length) parts.push(`(?:${other.join('|')})`);
  t.re = new RegExp(parts.join('|'), 'iu');
}
// Short words that are too common to count alone ("ai" in French means "have", "eth" etc.).
const AI_STRICT = /(?<![\p{L}])(?:AI|A\.I\.)(?![\p{L}])/u;

export const META = [
  { id: 'today', name: 'Last 24 hours', icon: '🕐' },
  { id: 'video', name: 'Videos', icon: '▶️' },
  { id: 'audio', name: 'Podcasts & audio', icon: '🎧' },
  { id: 'long', name: 'Long reads', icon: '📖' },
  { id: 'opinion', name: 'Opinion & analysis', icon: '💬' },
];
const OPINION = /(?<![\p{L}])(opinion|op-ed|oped|editorial|column|commentary|analysis|perspective|viewpoint|essay|tribune|éditorial|رأي|مقالات|تحليل|دیدگاه|یادداشت|мнение|колонка|аналитика)(?![\p{L}])/iu;
const isVideoLink = (l) => /(^https?:\/\/)?(www\.|m\.)?(youtube\.com\/watch|youtu\.be\/|vimeo\.com\/\d)/i.test(l || '');

const cache = new WeakMap();

/**
 * Smart folder ids an article belongs to: 'lang:xx', 'topic:id' and 'meta:id'.
 * feed: { title, lang, folders: [] }.
 */
export function classify(it, feed) {
  const hit = cache.get(it);
  if (hit && hit.feed === feed) return hit.ids;
  const ids = [];
  const text = `${it.t || ''}. ${it.s || ''}`;
  const lang = it.lg || detectLang(text, feed?.lang);
  if (lang) ids.push('lang:' + lang);
  const cats = (it.g || []).join(' · ');
  const folders = (feed?.folders || []).join(' · ');
  for (const t of TOPICS) {
    let score = 0;
    if (t.re.test(it.t || '')) score += 2;
    if (t.re.test(it.s || '')) score += 1;
    if (cats && t.re.test(cats)) score += 2;
    if (folders && t.folder.test(folders)) score += 2;
    if (t.id === 'ai' && score && !AI_STRICT.test(text) && !/intelligen|learning|llm|gpt|openai|anthropic|claude|gemini|chatbot|neural|deepmind|copilot|ذكاء|هوش|нейро|интеллект/i.test(`${text} ${cats} ${folders}`)) score = 0;
    if (score >= 2) ids.push('topic:' + t.id);
  }
  if (it.d > Date.now() - 864e5) ids.push('meta:today');
  if (it.m === 'video' || isVideoLink(it.l)) ids.push('meta:video');
  if (it.m === 'audio') ids.push('meta:audio');
  if (it.w >= 1200) ids.push('meta:long');
  if (OPINION.test(cats) || /^(opinion|analysis|column|editorial|op-ed)\s*[:|–-]/i.test(it.t || '') || /\/(opinion|opinions|commentary|editorial|analysis|columns?)\//i.test(it.l || '')) ids.push('meta:opinion');
  cache.set(it, { feed, ids });
  return ids;
}

/** Name and icon of a smart folder id. */
export function smartInfo(id) {
  const [kind, key] = id.split(':');
  if (kind === 'lang') return { name: LANGS[key] || key, icon: '🌐' };
  if (kind === 'topic') { const t = TOPICS.find((x) => x.id === key); return t ? { name: t.name, icon: t.icon } : null; }
  if (kind === 'meta') { const m = META.find((x) => x.id === key); return m ? { name: m.name, icon: m.icon } : null; }
  return null;
}

/** Words in an article's HTML (for "Long reads"). */
export const wordCount = (html) => (String(html || '').replace(/<[^>]+>/g, ' ').match(/[\p{L}\p{N}]+/gu) || []).length;

/** Media kind from an RSS/Atom entry's enclosure or media types ('' if none). */
export function mediaKind(types, link) {
  if (types.some((t) => /^audio\//i.test(t))) return 'audio';
  if (types.some((t) => /^video\/|^application\/x-shockwave|youtube/i.test(t)) || isVideoLink(link)) return 'video';
  return '';
}
