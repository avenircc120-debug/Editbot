/**
 * setup-webhook — Auto-suffisant
 * Configure ou vérifie le webhook Telegram.
 */

const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const webhookUrl = url.searchParams.get('url');

  if (webhookUrl) {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message'] }),
      },
    );
    return new Response(await res.text(), { headers: { 'Content-Type': 'application/json' } });
  }

  // Vérifier le webhook actuel
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo`);
  return new Response(await res.text(), { headers: { 'Content-Type': 'application/json' } });
});
