entity SourceDocs {
  key ID          : UUID;
      chunk       : LargeString;
      headingPath : LargeString not null;
      title       : String not null;
      source      : String not null;
      emb         : Vector = VECTOR_EMBEDDING(chunk, 'DOCUMENT') stored;
}
