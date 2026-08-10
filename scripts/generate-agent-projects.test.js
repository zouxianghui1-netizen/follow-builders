import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentProjectsFeed,
  parseWeeklyTrending,
} from "./generate-agent-projects.js";

const trendingHtml = `
<article class="Box-row">
  <h2><a href="/acme/agent-kit">acme / agent-kit</a></h2>
  <p class="col-9 color-fg-muted my-1 pr-4">A coding agent framework.</p>
  <a href="/acme/agent-kit/stargazers">1,234</a>
  <span itemprop="programmingLanguage">TypeScript</span>
  321 stars this week
</article>
<article class="Box-row">
  <h2><a href="/acme/database">acme / database</a></h2>
  <p class="col-9 color-fg-muted my-1 pr-4">A normal database.</p>
  999 stars this week
</article>`;

test("parseWeeklyTrending keeps Agent projects and preserves weekly evidence", () => {
  assert.deepEqual(parseWeeklyTrending(trendingHtml), [
    {
      name: "acme/agent-kit",
      url: "https://github.com/acme/agent-kit",
      description: "A coding agent framework.",
      language: "TypeScript",
      totalStars: 1234,
      weeklyStars: 321,
      heatType: "weekly-trending",
      pushedAt: null,
    },
  ]);
});

test("buildAgentProjectsFeed labels supplements without inventing weekly Stars", async () => {
  const searchItems = Array.from({ length: 12 }, (_, index) => ({
    full_name: `org/agent-${index}`,
    html_url: `https://github.com/org/agent-${index}`,
    description: "AI agent runtime",
    language: "Python",
    stargazers_count: 1000 - index,
    pushed_at: "2026-08-09T00:00:00Z",
  }));
  const fetchImpl = async (url) => {
    if (url === "https://github.com/trending?since=weekly") {
      return { ok: true, text: async () => trendingHtml };
    }
    return { ok: true, json: async () => ({ items: searchItems }) };
  };

  const feed = await buildAgentProjectsFeed({
    fetchImpl,
    now: new Date("2026-08-10T00:00:00Z"),
  });

  assert.equal(feed.projects.length, 10);
  assert.equal(feed.projects[0].weeklyStars, 321);
  assert.equal(feed.projects[1].heatType, "active-supplement");
  assert.equal(feed.projects[1].weeklyStars, null);
});
