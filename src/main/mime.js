// While a drag is still in progress the renderer only sees MIME types, not paths.
// This maps them to a representative extension so the wheel can be filled before the drop.
export const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heic',
  'image/tiff': 'tiff', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-ms-bmp': 'bmp', 'image/svg+xml': 'svg',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/*': 'png',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/webm': 'webm', 'video/x-msvideo': 'avi',
  'video/avi': 'avi', 'video/x-ms-wmv': 'wmv', 'video/mpeg': 'mpg', 'video/x-flv': 'flv', 'video/3gpp': '3gp', 'video/mp2t': 'ts',
  'video/x-m4v': 'm4v', 'video/*': 'mp4',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/wave': 'wav', 'audio/vnd.wave': 'wav', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
  'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff', 'audio/x-ms-wma': 'wma', 'audio/aac': 'aac', 'audio/*': 'mp3',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/msword': 'doc',
  'text/markdown': 'md', 'text/x-markdown': 'md', 'text/plain': 'txt', 'application/epub+zip': 'epub', 'application/rtf': 'rtf',
  'text/rtf': 'rtf', 'text/html': 'html', 'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx', 'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.ms-excel': 'xls',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods', 'text/csv': 'csv', 'text/tab-separated-values': 'tsv',
  'application/x-subrip': 'srt', 'text/vtt': 'vtt',
  'application/zip': 'zip', 'application/x-zip-compressed': 'zip', 'application/x-tar': 'tar', 'application/gzip': 'gz',
  'application/x-gzip': 'gz', 'application/vnd.rar': 'rar', 'application/x-rar-compressed': 'rar', 'application/x-compressed-tar': 'tgz',
};
