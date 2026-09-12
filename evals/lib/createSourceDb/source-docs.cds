entity SourceDocs {
  key ID          : UUID;
      chunk       : LargeString not null;
      headingPath : LargeString not null;
      title       : String not null;
      source      : String not null;
}
