using { bookshop } from '../db/schema.cds';

service CatalogService @(path: '/catalog') {
  entity Books   as projection on bookshop.Books;
  entity Authors as projection on bookshop.Authors;
}
