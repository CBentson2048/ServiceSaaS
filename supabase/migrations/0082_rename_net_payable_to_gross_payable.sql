-- Terminology change from Luke's Week 3-4 review: the settlement figure is pay
-- before tax/NI/pension, which payroll convention calls GROSS pay. "Net" read
-- as if deductions-after-tax had been applied. Display labels, contracts and
-- storage now all say "gross payable"; the figure itself is unchanged (still
-- signed, still after chair rent and salon deductions).

alter table payroll.pay_summaries
  rename column net_payable_cents to gross_payable_cents;

alter type payroll.pay_line_type_enum
  rename value 'net_payable' to 'gross_payable';

comment on column payroll.pay_summaries.gross_payable_cents is
  'Final settlement. Signed - negative means the stylist owes the business, which happens for renters whose rent and deductions exceed earnings.';
