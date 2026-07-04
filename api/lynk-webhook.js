import crypto from 'crypto';

// ==== CONFIG ====
const PIXEL_ID = '4587519888135581';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const MERCHANT_KEY = process.env.LYNK_MERCHANT_KEY;
const TEST_EVENT_CODE = process.env.TEST_EVENT_CODE || null;

// ==== HELPER: Validate Lynk Signature ====
function validateLynkSignature(refId, amount, messageId, receivedSignature, secretKey) {
  const signatureString = `${amount}${refId}${messageId}${secretKey}`;
  const calculatedSignature = crypto
    .createHash('sha256')
    .update(signatureString)
    .digest('hex');
  return calculatedSignature === receivedSignature;
}

// ==== HELPER: Hash user data (SHA-256) ====
function hashSHA256(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value).toLowerCase().trim()).digest('hex');
}

// ==== HELPER: Fire event ke Meta CAPI ====
async function fireMetaCAPI(eventName, data, req) {
  const { message_data, message_id } = data;
  const { customer, items, totals, refId } = message_data;

  const nameParts = customer?.name ? customer.name.split(' ') : [];
  const email = customer?.email || null;
  const phone = customer?.phone ? String(customer.phone).replace(/\D/g, '') : null;

  // ⭐ external_id = hashed email/refId (BOOST match quality)
  const externalIdRaw = email || refId || message_id;
  const externalId = externalIdRaw ? hashSHA256(externalIdRaw) : null;

  // ⭐ user_data TANPA IP + UA (karena dari Lynk backend, BUKAN buyer real)
  // Kalo kirim IP server Lynk (52.220.x.x = AWS Singapore) + UA "python-requests",
  // Meta detect sebagai "bot traffic" → event di-filter dari UI display
  const userData = {
    em: email ? [hashSHA256(email)] : [],
    ph: phone ? [hashSHA256(phone)] : [],
    fn: nameParts[0] ? [hashSHA256(nameParts[0])] : [],
    ln: nameParts.length > 1 ? [hashSHA256(nameParts.slice(1).join(' '))] : [],
    external_id: externalId ? [externalId] : [],
    country: [hashSHA256('id')]
  };

  const contentIds = items?.map(item => item.uuid) || [];
  const contents = items?.map(item => ({
    id: item.uuid,
    quantity: item.qty,
    item_price: item.price
  })) || [];
  const contentName = items?.[0]?.title || 'Unknown Product';

  const eventTime = Math.floor(Date.now() / 1000);
  const eventSourceUrl = `https://lynk.id/checkout/${refId || 'success'}`;

  const payload = {
    data: [{
      event_name: eventName,
      event_time: eventTime,
      event_id: refId || message_id,
      action_source: 'website',
      event_source_url: eventSourceUrl,
      user_data: userData,
      custom_data: {
        currency: 'IDR',
        value: totals?.grandTotal || totals?.totalPrice || 0,
        content_ids: contentIds,
        content_name: contentName,
        content_type: 'product',
        contents: contents,
        num_items: items?.length || 1,
        order_id: refId
      }
    }]
  };

  if (TEST_EVENT_CODE) {
    payload.test_event_code = TEST_EVENT_CODE;
  }

  const url = `https://graph.facebook.com/v19.0/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  return { ok: response.ok, result: await response.json(), payload };
}

// ==== MAIN HANDLER ====
export default async function handler(req, res) {
  // GET request → health check
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      message: 'Lynk-Meta CAPI Webhook is running',
      timestamp: new Date().toISOString()
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;
    const signature = req.headers['x-lynk-signature'];

    console.log('📥 Webhook received:', JSON.stringify(body).substring(0, 500));

    const eventType = body.event;
    const data = body.data;

    if (!data) {
      return res.status(400).json({ error: 'Invalid payload: missing data' });
    }

    const { message_id, message_data } = data;
    const refId = message_data?.refId;
    const grandTotal = message_data?.totals?.grandTotal;

    // ===== VERIFY SIGNATURE =====
    if (MERCHANT_KEY && signature) {
      const isValid = validateLynkSignature(refId, grandTotal, message_id, signature, MERCHANT_KEY);
      if (!isValid) {
        console.warn('⚠️ Invalid signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
      console.log('✅ Signature valid');
    } else {
      console.warn('⚠️ Signature verification skipped');
    }

    // ===== HANDLE EVENT =====
    if (eventType === 'payment.received' && data.message_action === 'SUCCESS') {
      const capiResult = await fireMetaCAPI('Purchase', data, req);
      console.log('📤 Meta CAPI Response:', JSON.stringify(capiResult.result));
      console.log('📤 User data sent:', JSON.stringify(capiResult.payload.data[0].user_data));

      return res.status(200).json({
        success: true,
        message: 'Purchase event fired to Meta CAPI',
        refId,
        grandTotal,
        meta_response: capiResult.result
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Event received but not processed',
      event: eventType
    });

  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
