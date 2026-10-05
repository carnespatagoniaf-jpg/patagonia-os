import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countByStatus, customerStatus, filterAndSortCustomers, matchesCustomerSearch, type CustomerListItem } from "./customer-list";

const TODAY = "2026-10-05";

const list: CustomerListItem[] = [
  { name: "Almacén Doña Rosa", number: 1, phone: "+54 9 2944 55-1234", balance: 0 },
  { name: "Bar El Puerto", number: 2, balance: 50000 },
  { name: "Carnicería Martín", number: 12, balance: 120000, paymentTermDays: 7, lastActivityDate: "2026-09-20" },
  { name: "Díaz Juan", number: 3, balance: -2000 },
  { name: "Escuela 45", number: 4, locality: "Bariloche", balance: 0.4 }
];

describe("customerStatus", () => {
  it("al día con saldo 0, a favor o centavos", () => {
    assert.equal(customerStatus(list[0], TODAY), "clear");
    assert.equal(customerStatus(list[3], TODAY), "clear");
    assert.equal(customerStatus(list[4], TODAY), "clear");
  });
  it("debe / atrasado", () => {
    assert.equal(customerStatus(list[1], TODAY), "owes");
    assert.equal(customerStatus(list[2], TODAY), "overdue");
  });
});

describe("matchesCustomerSearch", () => {
  it("por número exacto, con o sin #", () => {
    assert.ok(matchesCustomerSearch(list[2], "12"));
    assert.ok(matchesCustomerSearch(list[2], "#12"));
    assert.ok(matchesCustomerSearch(list[2], "Nº 12"));
    assert.ok(!matchesCustomerSearch(list[0], "12"));
  });
  it("por nombre sin tildes", () => {
    assert.ok(matchesCustomerSearch(list[0], "dona rosa"));
    assert.ok(matchesCustomerSearch(list[2], "CARNICERIA"));
  });
  it("por teléfono y localidad", () => {
    assert.ok(matchesCustomerSearch(list[0], "551234"));
    assert.ok(matchesCustomerSearch(list[4], "bariloche"));
  });
});

describe("filterAndSortCustomers", () => {
  it("atrasados primero, después los que deben (mayor deuda), después al día por nombre", () => {
    const names = filterAndSortCustomers(list, "", "all", TODAY).map((c) => c.number);
    assert.deepEqual(names, [12, 2, 1, 3, 4]);
  });
  it("filtros", () => {
    assert.deepEqual(filterAndSortCustomers(list, "", "owes", TODAY).map((c) => c.number), [12, 2]);
    assert.deepEqual(filterAndSortCustomers(list, "", "overdue", TODAY).map((c) => c.number), [12]);
    assert.deepEqual(filterAndSortCustomers(list, "", "clear", TODAY).map((c) => c.number), [1, 3, 4]);
  });
  it("cuenta por estado", () => {
    assert.deepEqual(countByStatus(list, TODAY), { all: 5, owes: 2, overdue: 1, clear: 3 });
  });
});
