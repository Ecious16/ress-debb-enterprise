'use strict';

// Starting catalogue. Seeded into the database on first boot only.
const DEFAULT_PRODUCTS = [
  { id: 'P-001', name: 'Wireless Mouse', category: 'Electronics', price: 8500, stock: 25, description: 'Ergonomic 2.4GHz wireless mouse for office use.' },
  { id: 'P-002', name: 'USB-C Charging Cable (1m)', category: 'Electronics', price: 3500, stock: 60, description: 'Braided fast-charging cable, 1 metre.' },
  { id: 'P-003', name: 'LED Desk Lamp', category: 'Electronics', price: 15000, stock: 12, description: 'Dimmable desk lamp with adjustable arm.' },
  { id: 'P-004', name: 'Bath Soap Carton (12 bars)', category: 'Essentials', price: 9000, stock: 30, description: 'Gentle everyday soap, carton of 12 bars.' },
  { id: 'P-005', name: 'Dish Washing Liquid (5L)', category: 'Essentials', price: 7500, stock: 20, description: 'Concentrated grease-cutting formula.' },
  { id: 'P-006', name: 'Bulk Rice (50kg)', category: 'Essentials', price: 85000, stock: 5, description: 'Long-grain parboiled rice, 50kg bag.' },
  { id: 'P-007', name: 'Corrugated Carton Boxes (Pack of 20)', category: 'Packaging', price: 12000, stock: 40, description: 'Strong double-wall boxes for shipping.' },
  { id: 'P-008', name: 'Bubble Wrap Roll (50m)', category: 'Packaging', price: 18000, stock: 10, description: 'Protective bubble wrap for fragile goods.' },
  { id: 'P-009', name: 'Packing Tape (Pack of 6)', category: 'Packaging', price: 6000, stock: 0, description: 'Heavy-duty clear packing tape.' },
];

module.exports = { DEFAULT_PRODUCTS };