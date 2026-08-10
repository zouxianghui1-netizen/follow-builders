#!/usr/bin/env node

import { writeFile } from "fs/promises";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const TRENDING_URL = "https://github.com/trending?since=weekly";
const SEARCH_URL = "https://api.github.com/search/repositories";
const OUTPUT_PATH = join(
  fileURLToPath(new URL("..", import.meta.url)),
  "feed-agent-projects.json",
);
const MAX_PROJECTS = 10;

function decodeHtml(value = "") {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    }
    if (lower.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    }
    return named[lower] ?? match;
  });
}

function cleanText(value = "") {
  return decodeHtml(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parseCount(value = "") {
  return Number.parseInt(value.replace(/,/g, ""), 10) || 0;
}

export function isAgentProject(project) {
  const text = `${project.name || ""} ${project.description || ""}`.toLowerCase();
  const include = [
    /\bagents?\b/,
    /\bagentic\b/,
    /\bmulti[- ]agent\b/,
    /\bcoding agent\b/,
    /\bcomputer use\b/,
    /\bmodel context protocol\b/,
    /\bmcp\b/,
    /\bagent skills?\b/,
    /\bskill router\b/,
    /\bbook-to-skill\b/,
    /\bcode[- ]graph[- ]rag\b/,
  ];
  const exclude = [
    /\bawesome[- ]list\b/,
    /\bcurated list\b/,
    /\bcourse\b/,
    /\btutorial collection\b/,
  ];
  return include.some((pattern) => pattern.test(text)) &&
    !exclude.some((pattern) => pattern.test(text));
}

export function parseWeeklyTrending(html) {
  const cards = html.match(/<article\b[^>]*class="[^"]*Box-row[^"]*"[^>]*>[\s\S]*?<\/article>/gi) || [];
  const projects = [];

  for (const card of cards) {
    const repoMatch = card.match(/<h2[\s\S]*?<a[^>]+href="\/([^"?#]+\/[^"/?#]+)"/i);
    if (!repoMatch) continue;

    const name = decodeHtml(repoMatch[1]);
    const descriptionMatch = card.match(/<p\b[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    const weeklyMatch = card.match(/([\d,]+)\s+stars?\s+this\s+week/i);
    const starLinkPattern = new RegExp(
      `href="/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/stargazers"[^>]*>([\\s\\S]*?)<\\/a>`,
      "i",
    );
    const totalStarsMatch = card.match(starLinkPattern);
    const languageMatch = card.match(/itemprop="programmingLanguage"[^>]*>([^<]+)</i);
    const project = {
      name,
      url: `https://github.com/${name}`,
      description: cleanText(descriptionMatch?.[1]),
      language: cleanText(languageMatch?.[1]) || null,
      totalStars: parseCount(cleanText(totalStarsMatch?.[1])),
      weeklyStars: parseCount(weeklyMatch?.[1]),
      heatType: "weekly-trending",
      pushedAt: null,
    };

    if (isAgentProject(project)) projects.push(project);
  }

  return projects.sort((a, b) => b.weeklyStars - a.weeklyStars);
}

function fromSearchItem(item) {
  return {
    name: item.full_name,
    url: item.html_url,
    description: item.description || "",
    language: item.language || null,
    totalStars: item.stargazers_count || 0,
    weeklyStars: null,
    heatType: "active-supplement",
    pushedAt: item.pushed_at || null,
  };
}

async function fetchText(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "follow-builders-agent-radar",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchActiveSupplements(fetchImpl, now) {
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const params = new URLSearchParams({
    q: `topic:ai-agent pushed:>=${since} archived:false fork:false`,
    sort: "stars",
    order: "desc",
    per_page: "50",
  });
  const response = await fetchImpl(`${SEARCH_URL}?${params}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "follow-builders-agent-radar",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  return (payload.items || [])
    .map(fromSearchItem)
    .filter(isAgentProject)
    .sort((a, b) => b.totalStars - a.totalStars);
}

export async function buildAgentProjectsFeed({
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const warnings = [];
  let trending = [];
  let supplements = [];

  try {
    trending = parseWeeklyTrending(await fetchText(fetchImpl, TRENDING_URL));
  } catch (error) {
    warnings.push(`GitHub Weekly Trending unavailable: ${error.message}`);
  }

  if (trending.length < MAX_PROJECTS) {
    try {
      supplements = await fetchActiveSupplements(fetchImpl, now);
    } catch (error) {
      warnings.push(`GitHub active-project supplement unavailable: ${error.message}`);
    }
  }

  const seen = new Set();
  const projects = [];
  for (const project of [...trending, ...supplements]) {
    const key = project.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push(project);
    if (projects.length === MAX_PROJECTS) break;
  }

  if (projects.length < MAX_PROJECTS) {
    warnings.push(`Only ${projects.length} verified Agent projects were available; no entries were fabricated.`);
  }

  return {
    generatedAt: now.toISOString(),
    snapshotDate: now.toISOString().slice(0, 10),
    methodology: "GitHub Weekly Trending Agent projects first; recently active GitHub topic:ai-agent repositories fill remaining slots. Supplement entries never claim weekly Star growth.",
    projects: projects.map((project, index) => ({ rank: index + 1, ...project })),
    stats: {
      total: projects.length,
      weeklyTrending: projects.filter((project) => project.heatType === "weekly-trending").length,
      activeSupplements: projects.filter((project) => project.heatType === "active-supplement").length,
    },
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

async function main() {
  const feed = await buildAgentProjectsFeed();
  await writeFile(OUTPUT_PATH, `${JSON.stringify(feed, null, 2)}\n`);
  console.error(
    `feed-agent-projects.json: ${feed.stats.total} projects (${feed.stats.weeklyTrending} weekly, ${feed.stats.activeSupplements} supplements)`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error("Agent project feed generation failed:", error.message);
    process.exit(1);
  });
}
