import { render, screen } from '@testing-library/react';

// zac-presentation imports the API client for its error copy, and that module
// reads `import.meta` (Vite), which the CommonJS test build cannot parse.
// Same stub the widget spec uses.
jest.mock('../../auth/api', () => ({
  ApiRequestError: class ApiRequestError extends Error {
    status = 500;
  },
}));

import { ZacAnswer } from './zac-presentation';

/**
 * The reported defect: a live answer arrives as Markdown from the synthesis
 * model and rendered as plain text, so the user reads the asterisks.
 */
const REPORTED = `Your diary is **0% full this week** — **0 of 15 available hours** are booked across **5 locations**. This is level with the previous period at **0%**.

The largest gap is **8 unbooked available hours** for **FTD on Tuesday 2026-09-08 at Kensington**.`;

describe('ZacAnswer', () => {
  it('renders the reported answer with emphasis instead of asterisks', () => {
    const { container } = render(<ZacAnswer text={REPORTED} />);

    // The literal delimiters must be gone from what the user reads.
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).toContain('0% full this week');

    const bold = Array.from(container.querySelectorAll('strong')).map((el) => el.textContent);
    expect(bold).toContain('0% full this week');
    expect(bold).toContain('0 of 15 available hours');
    expect(bold).toContain('FTD on Tuesday 2026-09-08 at Kensington');
  });

  it('splits blank-line separated blocks into separate paragraphs', () => {
    const { container } = render(<ZacAnswer text={REPORTED} />);
    expect(container.querySelectorAll('p')).toHaveLength(2);
  });

  it('renders bullet blocks as a real list', () => {
    const { container } = render(
      <ZacAnswer text={'Here is what I found:\n\n- Rebooking is **61%**\n- Retail is down\n• Diary is quiet'} />,
    );
    const items = Array.from(container.querySelectorAll('li')).map((el) => el.textContent);
    expect(items).toEqual(['Rebooking is 61%', 'Retail is down', 'Diary is quiet']);
    expect(container.querySelectorAll('ul')).toHaveLength(1);
  });

  it('renders numbered blocks as an ordered list', () => {
    const { container } = render(<ZacAnswer text={'1. First thing\n2. Second thing'} />);
    expect(container.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('keeps single newlines inside a block as line breaks', () => {
    const { container } = render(<ZacAnswer text={'Line one\nLine two'} />);
    expect(container.querySelectorAll('p')).toHaveLength(1);
    expect(container.querySelectorAll('br')).toHaveLength(1);
  });

  it('renders italics and inline code', () => {
    const { container } = render(<ZacAnswer text={'That is *roughly* the `report.client_retention` view'} />);
    expect(container.querySelector('em')?.textContent).toBe('roughly');
    expect(container.querySelector('code')?.textContent).toBe('report.client_retention');
  });

  it('never italicises the middle of an underscored identifier', () => {
    // `_emphasis_` is deliberately unsupported: ZAC names things like
    // report.client_retention and zac_tool_name, and underscore emphasis
    // would chew through them.
    const { container } = render(<ZacAnswer text={'Reading zac_tool_name and other_thing_here'} />);
    expect(container.querySelector('em')).toBeNull();
    expect(container.textContent).toContain('zac_tool_name');
  });

  it('leaves a stray delimiter exactly as written rather than swallowing it', () => {
    // Silently dropping an unmatched asterisk would alter the answer's text.
    const { container } = render(<ZacAnswer text={'A 5 * 3 calculation and an unclosed **bold'} />);
    expect(container.textContent).toBe('A 5 * 3 calculation and an unclosed **bold');
  });

  it('does not turn a model-supplied URL into a clickable link', () => {
    // Model-generated anchors are a phishing vector; the text shows, the
    // anchor does not.
    const { container } = render(
      <ZacAnswer text={'See [our report](https://evil.example.com/steal) for detail'} />,
    );
    expect(container.querySelector('a')).toBeNull();
  });

  it('escapes markup rather than rendering it', () => {
    const { container } = render(<ZacAnswer text={'<img src=x onerror="alert(1)"> and <b>hi</b>'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<img src=x');
  });

  it('renders a heading marker as emphasis, not a competing type scale', () => {
    const { container } = render(<ZacAnswer text={'## Summary'} />);
    expect(container.querySelectorAll('h1,h2,h3,h4,h5,h6')).toHaveLength(0);
    expect(screen.getByText('Summary')).toBeTruthy();
  });

  it('renders a plain answer unchanged', () => {
    const plain = 'You took 248 appointments in the last 7 days.';
    const { container } = render(<ZacAnswer text={plain} />);
    expect(container.textContent).toBe(plain);
  });
});
