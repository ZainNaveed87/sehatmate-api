import https from 'node:https';

function normalizeRecipients(to) {
  const values = Array.isArray(to) ? to : [to];
  return values
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
}

function senderEmail() {
  const from =
    process.env.SEHATMATE_FROM_EMAIL?.trim() ||
    process.env.PASSWORD_RESET_FROM_EMAIL?.trim();

  if (!from) {
    throw new Error(
      'SEHATMATE_FROM_EMAIL or PASSWORD_RESET_FROM_EMAIL is not configured.',
    );
  }

  return from;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => ({
      name: typeof tag?.name === 'string' ? tag.name.trim().slice(0, 256) : '',
      value: typeof tag?.value === 'string' ? tag.value.trim().slice(0, 256) : '',
    }))
    .filter((tag) => tag.name && tag.value);
}

function resendEmail(payload) {
  const apiKey = process.env.RESEND_API_KEY?.trim();

  if (!apiKey) {
    return Promise.reject(
      new Error('RESEND_API_KEY is not configured.'),
    );
  }

  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: 'api.resend.com',
        port: 443,
        path: '/emails',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let responseBody = '';

        response.setEncoding('utf8');

        response.on('data', (chunk) => {
          responseBody += chunk;
        });

        response.on('end', () => {
          const statusCode = Number(response.statusCode || 0);

          if (statusCode >= 200 && statusCode < 300) {
            resolve(responseBody);
            return;
          }

          const error = new Error(
            `Transactional email request failed with status ${statusCode}.`,
          );
          error.statusCode = statusCode;
          reject(error);
        });
      },
    );

    request.setTimeout(10000, () => {
      request.destroy(
        new Error('Transactional email request timed out.'),
      );
    });

    request.on('error', reject);

    request.write(body);
    request.end();
  });
}

export async function sendTransactionalEmail({
  to,
  subject,
  text,
  html,
  tags = [],
}) {
  const recipients = normalizeRecipients(to);
  const cleanSubject =
    typeof subject === 'string' ? subject.trim().slice(0, 500) : '';
  const cleanTextBody = typeof text === 'string' ? text : '';
  const cleanHtmlBody = typeof html === 'string' ? html : '';

  if (!recipients.length) {
    throw new Error('Transactional email recipient is required.');
  }
  if (!cleanSubject) {
    throw new Error('Transactional email subject is required.');
  }
  if (!cleanTextBody && !cleanHtmlBody) {
    throw new Error('Transactional email content is required.');
  }

  const payload = {
    from: senderEmail(),
    to: recipients,
    subject: cleanSubject,
    ...(cleanTextBody ? { text: cleanTextBody } : {}),
    ...(cleanHtmlBody ? { html: cleanHtmlBody } : {}),
  };

  const cleanTags = normalizeTags(tags);
  if (cleanTags.length) payload.tags = cleanTags;

  return resendEmail(payload);
}
