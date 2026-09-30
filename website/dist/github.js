// Keep the repository link useful even when GitHub is offline or rate-limited.
const badges = document.querySelectorAll('[data-github-stars]');
async function updateStars() {
  try {
    const response = await fetch('https://api.github.com/repos/madhurjyadc/kibu', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return;
    const { stargazers_count: count } = await response.json();
    if (!Number.isSafeInteger(count) || count < 0) return;
    const formatted = new Intl.NumberFormat('en').format(count);
    for (const badge of badges) {
      badge.querySelector('[data-star-label]').textContent = 'GitHub stars';
      const value = badge.querySelector('[data-star-count]');
      value.textContent = formatted;
      value.hidden = false;
      badge.setAttribute('aria-label', `${formatted} GitHub ${count === 1 ? 'star' : 'stars'}. Star Kibu on GitHub`);
    }
  } catch {
    // The static “Star on GitHub” link is the fallback, with no invented count.
  }
}
if (badges.length) updateStars();
