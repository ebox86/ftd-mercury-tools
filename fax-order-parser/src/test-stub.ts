import { FaxOrderFields } from './index';

// Example stub for future test cases
export const sampleOcrText = `
ORDER NUMBER: 123456
CUSTOMER NAME: John Doe
DELIVERY ADDRESS: 123 Main St, Springfield
PHONE NUMBER: (555) 123-4567
PRODUCT LIST: Roses x12, Lilies x6
DELIVERY DATE: 2026-04-14
SPECIAL INSTRUCTIONS: Leave at front desk
`;

export function testParseOrderFields() {
  // In the future, import parseOrderFields from index.ts
  // For now, just print the sample text
  console.log('Sample OCR text for testing:');
  console.log(sampleOcrText);
}

if (require.main === module) {
  testParseOrderFields();
}
