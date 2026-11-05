export const meta = {
  task: 'MY-forum.lowyat.net',
  want: 'w1',
  tier: 2,
  method: 'form_post',
  input: 'company name',
  fields: ['title', 'topic_id', 'forum', 'replies', 'topic_starter', 'url'],
  canary: { found: 'All IT Hypermarket', not_found: 'Dezeno' },
};

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  const searchPageUrl = 'https://forum.lowyat.net/index.php?act=Search';
  try {
    const getRes = await fetch(searchPageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!getRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: searchPageUrl,
        excerpt: `HTTP status ${getRes.status}`,
      };
    }

    const cookie = getRes.headers.get('set-cookie');
    const getHtml = await getRes.text();

    const formMatch = getHtml.match(/<form action="([^"]+)"[^>]*name="sForm"/i);
    if (!formMatch) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: searchPageUrl,
        excerpt: 'Search form with name="sForm" not found on page',
      };
    }

    const actionUrl = formMatch[1].replace(/&amp;/g, '&');

    const selectSlice = getHtml.slice(getHtml.indexOf("name='forums[]'"), getHtml.indexOf("</select>"));
    const optionValues = [...selectSlice.matchAll(/value="([^"]+)"/g)].map(m => m[1]);

    const params = new URLSearchParams();
    const searchKeyword = keyword.includes(' ') && !keyword.startsWith('"') ? `"${keyword}"` : keyword;
    params.append('keywords', searchKeyword);
    params.append('namesearch', '');
    params.append('searchsubs', '1');
    params.append('prune_type', 'newer');
    params.append('sort_order', 'desc');
    params.append('search_in', 'posts');
    params.append('result_type', 'topics');
    for (const f of optionValues) params.append('forums[]', f);

    const postRes = await fetch(actionUrl, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': searchPageUrl,
        ...(cookie ? { 'Cookie': cookie } : {}),
      },
      body: params.toString(),
    });

    if (!postRes.ok) {
      return {
        status: 'couldnt_check',
        reason: 'http_error',
        records: [],
        source_url: actionUrl,
        excerpt: `POST search failed with HTTP status ${postRes.status}`,
      };
    }

    const postHtml = await postRes.text();

    if (!postHtml.includes('Search Results') && !postHtml.includes('Board Message')) {
      return {
        status: 'couldnt_check',
        reason: 'layout_changed',
        records: [],
        source_url: actionUrl,
        excerpt: 'Expected search results or board message layout not returned',
      };
    }

    const entryRegex = /<!-- Begin Topic Entry (\d+) -->([\s\S]*?)<!-- End Topic Entry \1 -->/gi;
    let match;
    const records = [];
    let bestExcerpt = '';

    while ((match = entryRegex.exec(postHtml)) !== null) {
      const topicId = match[1];
      const entryHtml = match[2];

      const titleMatch = entryHtml.match(/<td width="100%">[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const rawTitle = titleMatch ? titleMatch[2].replace(/<[^>]+>/g, '').trim() : '';
      const topicUrl = titleMatch ? titleMatch[1].replace(/&amp;/g, '&') : `https://forum.lowyat.net/topic/${topicId}`;

      const forumMatch = entryHtml.match(/<span class="forumdesc"><a[^>]*>([^<]+)<\/a><\/span>/i);
      const forum = forumMatch ? forumMatch[1].trim() : '';

      const repliesMatch = entryHtml.match(/who_posted\(\d+\);">([^<]+)<\/a>/i);
      const replies = repliesMatch ? repliesMatch[1].trim() : '';

      const starterMatch = entryHtml.match(/showuser=\d+'>([^<]+)<\/a>/i);
      const starter = starterMatch ? starterMatch[1].trim() : '';

      const cleanExcerpt = entryHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (!bestExcerpt) bestExcerpt = cleanExcerpt;

      records.push({
        title: rawTitle,
        topic_id: topicId,
        forum,
        replies,
        topic_starter: starter,
        url: topicUrl,
      });
    }

    if (records.length === 0) {
      return {
        status: 'not_found',
        reason: '',
        records: [],
        source_url: actionUrl,
        excerpt: `No forum discussions or complaint threads found matching "${keyword}" on Lowyat.NET`,
      };
    }

    return {
      status: 'found',
      reason: '',
      records,
      source_url: actionUrl,
      excerpt: bestExcerpt,
    };
  } catch (err) {
    return {
      status: 'couldnt_check',
      reason: 'timeout',
      records: [],
      source_url: searchPageUrl,
      excerpt: String(err),
    };
  }
}
