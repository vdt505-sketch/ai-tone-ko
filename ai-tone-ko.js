#!/usr/bin/env node
'use strict';
/*
 * ai-tone-ko — 한국어 글·화면에서 "AI가 쓴 티"로 자주 지목되는 표면 패턴을 센다.
 *
 * 이 도구는 글의 품질이나 '사람이 썼는지'를 판정하지 않는다. 정해진 표면 패턴의 밀도만 잰다.
 * 점수가 낮다 = 그 패턴이 적다. 좋은 글이라는 뜻은 아니다. 마지막 판단은 사람이 소리 내어 읽고 한다.
 *
 *   node ai-tone-ko.js <파일·폴더...>              점수표 (.html .htm .md .txt)
 *   node ai-tone-ko.js <...> --detail              어디에서 걸렸는지
 *   node ai-tone-ko.js <...> --json > before.json  기계 판독(전후 비교용)
 *   node ai-tone-ko.js <...> --compare before.json 점수만 보지 않고 원시 건수·글자 수 변화까지
 *
 * 의존성 0. Node 18 이상.
 */
const fs = require('fs');
const path = require('path');

const EXT = new Set(['.html', '.htm', '.md', '.markdown', '.txt']);
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor']);

/** 화면에 보이는 글자만 남긴다(스크립트·스타일·주석·태그 제거). */
function visibleText(src, ext) {
  let s = src;
  if (ext === '.html' || ext === '.htm') {
    s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ');
  } else if (ext === '.md' || ext === '.markdown') {
    s = s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  }
  return s.replace(/[ \t]+/g, ' ');
}

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;

/** 반복되면 격이 떨어지는 상투구. 한 번 쓰는 건 괜찮다 — 많이 쌓일 때 문제다. */
const CLICHES = [
  '아이디어만 있어도', '편하게 상담', '편하게 문의', '무엇이든 상담', '무엇이든 물어',
  '혁신적', '획기적', '최적의 솔루션', '토탈 솔루션', '원스톱', '고객 만족', '합리적인 가격',
  '차별화된', '최고의', '완벽한', '한 단계 더', '새로운 차원', '극대화', '시너지', '게임 체인저',
  '패러다임', '여정을 함께', '함께 성장', '가치를 더합니다', '경험을 선사',
];

function countMatches(s, re) {
  const m = s.match(re);
  return { count: m ? m.length : 0, hits: m ? [...new Set(m)].slice(0, 8).map((x) => String(x).trim()) : [] };
}

const METRICS = {
  emoji: {
    label: '이모지', weight: 3,
    why: '제목·카드마다 붙는 이모지는 생성물의 대표 신호',
    // 체크 표시(✓✔☑✅)는 아래 '체크 줄세우기'에서 따로 세므로 여기선 뺀다
    scan: (raw, text) => countMatches(text.replace(/[✓✔☑✅]/g, ''), EMOJI),
  },
  checkmark: {
    label: '체크 줄세우기', weight: 2,
    why: '같은 길이 항목을 ✓로 줄세우면 기계가 만든 표처럼 보인다',
    scan: (raw, text) => countMatches(text, /[✓✔☑✅]/g),
  },
  eyebrow_en: {
    label: '영어 라벨', weight: 2,
    why: '한국어 제목 위에 장식처럼 붙는 짧은 영어 라벨(About · Features …)',
    scan: (raw, text, ext) => {
      if (ext === '.html' || ext === '.htm') {
        return countMatches(raw, /class="[^"]*(?:eyebrow|kicker|overline|label)[^"]*"[^>]*>\s*([A-Za-z][A-Za-z0-9 .&·'-]{2,40})\s*</g);
      }
      // 글 파일: 영어만으로 된 짧은 줄(1~4단어)이 한국어 문서 안에 반복될 때
      const lines = text.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim());
      const hits = lines.filter((l) => /^[A-Za-z][A-Za-z0-9 .&'-]{1,30}$/.test(l) && l.split(' ').length <= 4);
      return { count: hits.length, hits: [...new Set(hits)].slice(0, 8) };
    },
  },
  emdash: {
    label: 'em대시(—)', weight: 1,
    why: '한국어 문장에 —를 자주 끼우면 번역투·기계 호흡이 된다',
    scan: (raw, text) => countMatches(text, /—/g),
  },
  cliche: {
    label: '상투구', weight: 4,
    why: CLICHES.slice(0, 5).join(' / ') + ' 등',
    scan: (raw, text) => {
      let n = 0; const hits = [];
      for (const c of CLICHES) { const m = text.split(c).length - 1; if (m) { n += m; hits.push(`${c}×${m}`); } }
      return { count: n, hits };
    },
  },
  same_ending: {
    label: '같은 끝말 3연속', weight: 2,
    why: '"제공합니다. 제공합니다. 제공합니다."처럼 문장 끝 낱말이 3번 이어지면 리듬이 기계적',
    scan: (raw, text) => {
      const ends = text.split(/(?<=[.!?。])\s+/).map((s) => s.trim()).filter((s) => s.length > 4)
        .map((s) => (s.match(/([가-힣]+)[.!?。]$/) || [])[1] || '');
      let n = 0; const hits = [];
      for (let i = 2; i < ends.length; i++) {
        if (ends[i] && ends[i] === ends[i - 1] && ends[i] === ends[i - 2]) { n++; hits.push(ends[i]); }
      }
      return { count: n, hits: [...new Set(hits)].slice(0, 8) };
    },
  },
  triple_card: {
    label: '3단 대칭 카드', weight: 2,
    why: '똑같은 3칸 카드 묶음의 반복 = 템플릿 인상',
    scan: (raw, text, ext) => (ext === '.html' || ext === '.htm')
      ? countMatches(raw, /class="[^"]*\bgrid-3\b[^"]*"|grid-template-columns:\s*repeat\(\s*3\s*,/g)
      : { count: 0, hits: [] },
  },
  gradient: {
    label: '그라데이션·글로우', weight: 0.5,
    why: '내용 대신 장식으로 고급감을 내려는 구성',
    scan: (raw, text, ext) => {
      if (!(ext === '.html' || ext === '.htm')) return { count: 0, hits: [] };
      // 초점 링(:focus)의 그림자는 장식이 아니라 접근성 기능이라 뺀다
      const kept = raw.replace(/[^{}]*:focus[^{}]*\{[^}]*\}/g, ' ');
      return countMatches(kept, /linear-gradient|radial-gradient|box-shadow:[^;"]*rgba\([^)]*\)/g);
    },
  },
};

function listFiles(targets) {
  const out = [];
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch (e) { console.error(`건너뜀(열 수 없음): ${p} — ${e.code || e.message}`); return; }
    if (st.isDirectory()) {
      if (SKIP_DIR.has(path.basename(p))) return;
      for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n));
    } else if (EXT.has(path.extname(p).toLowerCase())) out.push(p);
  };
  targets.forEach(walk);
  return out;
}

function analyze(file) {
  const ext = path.extname(file).toLowerCase();
  const raw = fs.readFileSync(file, 'utf8');
  const text = visibleText(raw, ext);
  const chars = text.replace(/\s/g, '').length;
  const row = { file, chars, metrics: {}, score: 0 };
  for (const [key, m] of Object.entries(METRICS)) {
    const r = m.scan(raw, text, ext);
    row.metrics[key] = r;
    row.score += m.weight * r.count * (1000 / Math.max(chars, 1));
  }
  row.score = Math.round(row.score * 10) / 10;
  return row;
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const cmpIdx = argv.indexOf('--compare');
  const targets = argv.filter((a, i) => !a.startsWith('--') && !(cmpIdx > -1 && i === cmpIdx + 1));
  if (!targets.length || flags.has('--help')) {
    console.log('사용: node ai-tone-ko.js <파일·폴더...> [--detail] [--json] [--compare before.json]');
    return 0;
  }
  const rows = listFiles(targets).map(analyze).sort((a, b) => b.score - a.score);
  if (!rows.length) { console.error('읽을 파일이 없습니다(.html .htm .md .txt).'); return 2; }

  if (flags.has('--json')) {
    console.log(JSON.stringify({ tool: 'ai-tone-ko', generatedAt: new Date().toISOString(), rows }, null, 2));
    return 0;
  }

  const keys = Object.keys(METRICS);
  const pad = (s, n) => String(s).padEnd(n);
  const name = (f) => path.relative(process.cwd(), f) || f;

  if (cmpIdx > -1) {
    const before = JSON.parse(fs.readFileSync(argv[cmpIdx + 1], 'utf8')).rows;
    const raw = (r) => Object.values(r.metrics).reduce((s, m) => s + m.count, 0);
    console.log('\n전후 비교 — 점수만으로 판단하지 않는다\n');
    for (const a of rows) {
      const b = before.find((x) => path.resolve(x.file) === path.resolve(a.file));
      if (!b) continue;
      const dChars = (a.chars - b.chars) / Math.max(b.chars, 1) * 100;
      const rb = raw(b), ra = raw(a);
      let verdict = '변화 없음';
      if (ra < rb && dChars <= 5) verdict = '실제 제거';
      else if (ra < rb) verdict = '제거 + 글자 증가(확인 필요)';
      else if (a.score < b.score) verdict = '⚠ 희석 의심 — 패턴은 그대로인데 글자만 늘어 점수가 내려감';
      else if (ra > rb) verdict = '⚠ 패턴 증가';
      console.log(`${name(a.file)}\n  점수 ${b.score} → ${a.score} · 원시 ${rb} → ${ra} · 글자 ${b.chars} → ${a.chars} (${dChars >= 0 ? '+' : ''}${dChars.toFixed(1)}%) · ${verdict}`);
    }
    console.log('');
    return 0;
  }

  console.log('\nai-tone-ko — 표면 패턴의 1000자당 가중 밀도 (글의 품질 판정이 아니다)\n');
  console.log(pad('점수', 7) + keys.map((k) => pad(METRICS[k].label, 14)).join('') + '파일');
  for (const r of rows) console.log(pad(r.score, 7) + keys.map((k) => pad(r.metrics[k].count, 14)).join('') + name(r.file));
  console.log('\n주의: 점수는 글자 수로 나눈 밀도라 문장을 늘려도 내려간다. 전후 비교는 --compare로 원시 건수와 글자 수를 함께 본다.');
  if (flags.has('--detail')) {
    console.log('\n── 어디에서 걸렸나 ──');
    for (const r of rows) {
      const found = keys.filter((k) => r.metrics[k].count > 0 && r.metrics[k].hits.length);
      if (!found.length) continue;
      console.log(`\n[${name(r.file)}] 점수 ${r.score}`);
      for (const k of found) console.log(`  ${METRICS[k].label}(${r.metrics[k].count}): ${r.metrics[k].hits.join(' · ')}`);
    }
  } else {
    console.log('\n지표 뜻:');
    for (const k of keys) console.log(`  ${pad(METRICS[k].label, 16)} ${METRICS[k].why}`);
  }
  console.log('');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { analyze, visibleText, METRICS, CLICHES };
