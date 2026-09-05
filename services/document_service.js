import {
  cleanText,
  idPattern,
} from './shared_utils.js';

function serviceFailure(code, message, data = undefined) {
  return {
    ok: false,
    code,
    message,
    ...(data === undefined ? {} : { data }),
  };
}

function documentMetadataJson(row) {
  return {
    id: String(row.id),
    carePlanId: String(row.care_plan_id),
    carePlanTitle: cleanText(row.care_plan_title, 160) || 'Care plan',
    documentType: cleanText(row.document_type, 40) || 'other',
    originalName: cleanText(row.original_name, 240) || 'Document',
    mimeType: cleanText(row.mime_type, 100),
    fileSizeBytes: Number(row.file_size_bytes || 0),
    pageCount: row.page_count == null ? null : Number(row.page_count),
    processingStatus: cleanText(row.processing_status, 40) || 'uploaded',
    processingError: cleanText(row.processing_error, 500) || null,
    createdAt: row.created_at || null,
    instructionCount: Number(row.instruction_count || 0),
    verifiedInstructionCount: Number(row.verified_instruction_count || 0),
  };
}

export async function listDocuments({ pool, userId }) {
  const [rows] = await pool.execute(
    `SELECT d.id, d.care_plan_id, p.title AS care_plan_title,
      d.document_type, d.original_name, d.mime_type, d.file_size_bytes,
      d.page_count, d.processing_status, d.processing_error, d.created_at,
      COUNT(i.id) AS instruction_count,
      SUM(CASE WHEN i.review_status = 'verified' THEN 1 ELSE 0 END)
        AS verified_instruction_count
     FROM care_documents d
     JOIN care_plans p ON p.id = d.care_plan_id
     LEFT JOIN extracted_instructions i
       ON i.document_id = d.id
      AND i.care_plan_id = d.care_plan_id
     WHERE d.user_id = ?
       AND p.user_id = ?
     GROUP BY d.id, d.care_plan_id, p.title, d.document_type,
       d.original_name, d.mime_type, d.file_size_bytes, d.page_count,
       d.processing_status, d.processing_error, d.created_at
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT 100`,
    [userId, userId],
  );

  return {
    ok: true,
    data: {
      documents: rows.map(documentMetadataJson),
    },
  };
}

export async function readDocumentFile({ pool, userId, documentId }) {
  if (!idPattern.test(cleanText(documentId, 20))) {
    return serviceFailure('INVALID_DOCUMENT_ID', 'Invalid document ID.');
  }

  const [rows] = await pool.execute(
    `SELECT id, original_name, mime_type, file_size_bytes, file_data
     FROM care_documents
     WHERE id = ? AND user_id = ?
     LIMIT 1`,
    [documentId, userId],
  );
  const document = rows[0];
  if (!document || !document.file_data) {
    return serviceFailure('DOCUMENT_NOT_FOUND', 'Document file not found.');
  }

  return {
    ok: true,
    data: {
      document: {
        id: String(document.id),
        originalName: cleanText(document.original_name, 240) || 'Document',
        mimeType: cleanText(document.mime_type, 100),
        fileSizeBytes: Number(document.file_size_bytes || 0),
        fileData: document.file_data,
      },
    },
  };
}

export async function deleteDocument({ pool, userId, documentId }) {
  if (!idPattern.test(cleanText(documentId, 20))) {
    return serviceFailure('INVALID_DOCUMENT_ID', 'Invalid document ID.');
  }

  const [documents] = await pool.execute(
    `SELECT id, care_plan_id
     FROM care_documents
     WHERE id = ? AND user_id = ?
     LIMIT 1`,
    [documentId, userId],
  );
  const document = documents[0];
  if (!document) {
    return serviceFailure('DOCUMENT_NOT_FOUND', 'Document not found.');
  }

  await pool.execute(
    'DELETE FROM care_documents WHERE id = ? AND user_id = ?',
    [documentId, userId],
  );
  const [[counts]] = await pool.execute(
    'SELECT COUNT(*) AS document_count FROM care_documents WHERE care_plan_id = ?',
    [document.care_plan_id],
  );
  if (Number(counts.document_count || 0) === 0) {
    await pool.execute(
      `UPDATE care_plans SET status = 'draft'
       WHERE id = ? AND user_id = ? AND status = 'processing'`,
      [document.care_plan_id, userId],
    );
  }

  return {
    ok: true,
    data: {
      carePlanId: String(document.care_plan_id),
      remainingDocumentCount: Number(counts.document_count || 0),
    },
  };
}
