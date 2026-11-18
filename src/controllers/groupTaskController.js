import * as groupTaskService from '../services/groupTaskService.js';
import * as v from '../validators/index.js';

const groupTaskId = (req) => v.id(req.params.groupTaskId, 'tasca');

export async function board(req, res) {
  res.json(await groupTaskService.board(req.user, v.id(req.params.groupId, 'grup')));
}

export async function detail(req, res) {
  res.json(await groupTaskService.detail(req.user, groupTaskId(req)));
}

export async function changeStatus(req, res) {
  res.json(await groupTaskService.changeStatus(req.user, groupTaskId(req), req.body));
}

export async function transferResponsibility(req, res) {
  res.json(await groupTaskService.transferResponsibility(req.user, groupTaskId(req), req.body));
}

export async function addComment(req, res) {
  res.status(201).json(await groupTaskService.addComment(req.user, groupTaskId(req), req.body));
}

export async function history(req, res) {
  res.json(await groupTaskService.history(req.user, groupTaskId(req)));
}

// Runs before the upload middleware: no file is stored for a user who is not
// allowed to contribute to the task.
export async function checkUploadAccess(req, res, next) {
  await groupTaskService.assertCanContribute(req.user, groupTaskId(req));
  next();
}

// Accepts either a multipart file upload or a JSON body with a link.
export async function addAttachment(req, res) {
  const result = req.is('multipart/form-data')
    ? await groupTaskService.addFile(req.user, groupTaskId(req), req.file)
    : await groupTaskService.addLink(req.user, groupTaskId(req), req.body);
  res.status(201).json(result);
}

export async function downloadAttachment(req, res) {
  const file = await groupTaskService.download(req.user, v.id(req.params.attachmentId, 'fitxer'));
  // Uploaded content is never allowed to run scripts, even when shown inline.
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  res.set('X-Content-Type-Options', 'nosniff');
  res.type(file.mimeType);
  res.attachment(file.filename);
  if (file.inline) res.set('Content-Disposition', res.get('Content-Disposition').replace(/^attachment/, 'inline'));
  res.sendFile(file.path, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: { code: 'not_found', message: "No s'ha trobat el fitxer." } });
    }
  });
}
