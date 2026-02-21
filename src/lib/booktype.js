'use strict';

/**
 * Enum of all known Bookmate content types.
 * Only BOOK, SERIAL and AUDIO are currently supported for download.
 */
export const BookType = Object.freeze({
  BOOK:      'book',
  SERIAL:    'serial',
  AUDIO:     'audio',
  COMICBOOK: 'comicbook',  // not yet supported for download
  SERIES:    'series',     // not yet supported for download
});
