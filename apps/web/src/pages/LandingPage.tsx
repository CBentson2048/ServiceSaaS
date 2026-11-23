import { Link } from 'react-router-dom';
import { BrandLogo } from '../components/BrandLogo';
import { sheerAppAndroidUrl, sheerAppIosUrl } from '../config/mobileApp';

const PLATFORM_AREAS = [
  ['01', 'Run the day', 'Live bookings, deposits, rotas, and client context move together—without the morning spreadsheet ritual.'],
  ['02', 'Protect the margin', 'See colour cost, stock exposure, payroll readiness, and service performance before they become month-end surprises.'],
  ['03', 'Grow with intent', 'Turn rebooking, client signals, and team performance into timely actions that feel personal—not automated.'],
];

const SIGNALS = [
  ['£8.4k', 'revenue in view', '+12.6% vs last week'],
  ['84%', 'rebooking rate', '6 clients need attention'],
  ['£312', 'margin protected', 'from stock & formula signals'],
];

const DAY_EVENTS = [
  ['09:30', 'Full head colour', 'Amelia R.', 'Arrived'],
  ['11:15', 'Cut & finish', 'James T.', 'Confirmed'],
  ['13:00', 'Balayage & gloss', 'Sofia M.', 'Deposit paid'],
];

export function LandingPage() {
  return (
    <main className="landing min-h-screen overflow-hidden bg-[#f6f0e8] text-[#241b25]">
      <header className="relative z-30 mx-auto flex max-w-[1240px] items-center justify-between px-5 py-5 lg:px-8 lg:py-7">
        <Link to="/" aria-label="Service SaaS home" className="inline-flex items-center">
          <BrandLogo className="h-7" />
        </Link>
        <nav aria-label="Primary navigation" className="hidden items-center gap-8 text-sm font-medium text-[#675b63] md:flex">
          <a href="#platform" className="transition-colors hover:text-[#241b25]">Platform</a>
          <a href="#intelligence" className="transition-colors hover:text-[#241b25]">Intelligence</a>
          <a href="#ecosystem" className="transition-colors hover:text-[#241b25]">Ecosystem</a>
        </nav>
        <div className="flex items-center gap-2">
          <Link to="/login" className="hidden rounded-full px-4 py-2.5 text-sm font-semibold text-[#4d4249] transition-colors hover:bg-white/70 sm:inline-flex">Log in</Link>
          <Link to="/owner/onboarding" className="inline-flex rounded-full bg-[#392032] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(57,32,50,.18)] transition-all hover:-translate-y-0.5 hover:bg-[#24131f] sm:px-5">Start free</Link>
        </div>
      </header>

      <section className="relative mx-auto max-w-[1240px] px-5 pb-14 pt-6 lg:px-8 lg:pb-24 lg:pt-10">
        <div className="absolute -left-32 -top-24 h-80 w-80 rounded-full bg-[#f0ad95]/25 blur-3xl" />
        <div className="relative grid items-center gap-12 lg:grid-cols-[.92fr_1.08fr] lg:gap-16">
          <div className="relative z-10">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#d8c9bd] bg-white/55 px-3.5 py-2 text-[11px] font-bold uppercase tracking-[.16em] text-[#714a5e] backdrop-blur">
              <span className="h-2 w-2 rounded-full bg-[#d86f58]" />
              The operating system for ambitious salons
            </div>
            <h1 className="font-serif text-[48px] leading-[.98] tracking-[-.045em] text-[#2c1c29] sm:text-[64px] lg:text-[76px]">
              Run the business.<br /><span className="italic text-[#9b4d5c]">Keep the craft.</span>
            </h1>
            <p className="mt-7 max-w-xl text-[17px] leading-7 text-[#685c62] sm:text-lg sm:leading-8">
              Service SaaS brings the commercial intelligence of a great operator into every salon day—connecting bookings, clients, teams, stock, payroll, and growth in one calm workspace.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link to="/owner/onboarding" className="inline-flex items-center justify-center gap-2 rounded-full bg-[#392032] px-6 py-3.5 text-sm font-bold text-white shadow-[0_14px_35px_rgba(57,32,50,.2)] transition-all hover:-translate-y-0.5 hover:bg-[#24131f]">Build a stronger salon <ArrowIcon /></Link>
              <a href="#platform" className="inline-flex items-center justify-center rounded-full border border-[#bfaea5] bg-white/45 px-6 py-3.5 text-sm font-bold text-[#392f35] transition-colors hover:bg-white">Explore the platform</a>
            </div>
            <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3 text-xs font-semibold text-[#70646a]">
              <span className="flex items-center gap-2"><CheckIcon /> No card required</span>
              <span className="flex items-center gap-2"><CheckIcon /> Multi-location ready</span>
              <span className="flex items-center gap-2"><CheckIcon /> Built with salon operators</span>
            </div>
          </div>
          <div className="relative min-h-[520px] lg:min-h-[610px]">
            <div className="absolute inset-x-4 top-4 h-[86%] rotate-2 rounded-[34px] bg-[#db826c] lg:inset-x-8" />
            <img src="/salon-owner-operations.png" alt="Salon owner reviewing her business on a tablet while her team serves a client" className="relative h-[520px] w-full rounded-[32px] object-cover object-[58%_center] shadow-[0_30px_70px_rgba(61,39,46,.24)] lg:h-[610px]" />
            <div className="absolute -bottom-5 left-2 right-2 rounded-[24px] border border-white/50 bg-[#241722]/95 p-4 text-white shadow-2xl backdrop-blur md:left-auto md:right-5 md:w-[360px] md:p-5">
              <div className="flex items-center justify-between"><div><div className="text-[10px] font-bold uppercase tracking-[.18em] text-white/45">Live business signal</div><div className="mt-1 text-sm font-semibold">Today is pacing ahead</div></div><span className="rounded-full bg-[#d9f1df] px-2.5 py-1 text-xs font-bold text-[#24613b]">+12.6%</span></div>
              <div className="mt-4 flex h-12 items-end gap-1.5" aria-hidden="true">{[35, 48, 42, 58, 53, 72, 64, 82, 76, 92, 86, 100].map((height, index) => <span key={index} className="flex-1 rounded-t-sm bg-[#e5856e]" style={{ height: `${height}%`, opacity: .45 + index * .04 }} />)}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-[#ded2c8] bg-[#fffaf4]"><div className="mx-auto grid max-w-[1240px] grid-cols-2 gap-6 px-5 py-6 text-center sm:grid-cols-4 lg:px-8">{['Bookings', 'Client CRM', 'Team & payroll', 'Stock & colour'].map((item) => <div key={item} className="text-[11px] font-bold uppercase tracking-[.16em] text-[#8a777d]">{item}</div>)}</div></section>

      <section id="platform" className="mx-auto max-w-[1240px] px-5 py-20 lg:px-8 lg:py-28">
        <div className="grid gap-10 lg:grid-cols-[.8fr_1.2fr] lg:gap-20">
          <div><Eyebrow>One connected operation</Eyebrow><h2 className="mt-5 max-w-lg font-serif text-[40px] leading-[1.05] tracking-[-.035em] sm:text-[54px]">Less admin theatre.<br />More useful action.</h2><p className="mt-6 max-w-md text-[16px] leading-7 text-[#6f6268]">Most salon tools record what happened. Service SaaS helps your team decide what to do next—while the moment still matters.</p></div>
          <div className="divide-y divide-[#d7cbc2] border-y border-[#d7cbc2]">{PLATFORM_AREAS.map(([number, title, body]) => <div key={number} className="group grid gap-3 py-7 sm:grid-cols-[60px_180px_1fr] sm:items-start sm:gap-5"><span className="text-xs font-bold text-[#c45f52]">{number}</span><h3 className="text-lg font-bold tracking-[-.02em] text-[#32262d]">{title}</h3><p className="text-sm leading-6 text-[#75696f]">{body}</p></div>)}</div>
        </div>
      </section>

      <section id="intelligence" className="bg-[#2b1927] px-5 py-20 text-white lg:py-28">
        <div className="mx-auto max-w-[1240px]">
          <div className="flex flex-col justify-between gap-7 md:flex-row md:items-end"><div><Eyebrow dark>From activity to intelligence</Eyebrow><h2 className="mt-5 max-w-2xl font-serif text-[40px] leading-[1.05] tracking-[-.035em] sm:text-[54px]">A clearer view of today.<br /><span className="italic text-[#e99a85]">A smarter next move.</span></h2></div><p className="max-w-sm text-sm leading-6 text-white/55">One live picture connects commercial performance with what is actually happening on the salon floor.</p></div>
          <div className="mt-12 overflow-hidden rounded-[28px] border border-white/10 bg-[#f9f4ec] text-[#2c2228] shadow-[0_30px_70px_rgba(0,0,0,.22)]">
            <div className="flex flex-col border-b border-[#ded5cd] bg-white/65 px-5 py-4 sm:flex-row sm:items-center sm:justify-between lg:px-7"><div><span className="text-xs font-bold uppercase tracking-[.16em] text-[#8d7b83]">Good morning, Maya</span><h3 className="mt-1 text-xl font-bold">Pinner is ready for the day.</h3></div><div className="mt-3 flex items-center gap-2 sm:mt-0"><span className="h-2 w-2 rounded-full bg-[#3d9b62]" /><span className="text-xs font-semibold text-[#5f555a]">Live · updated just now</span></div></div>
            <div className="grid lg:grid-cols-[1.4fr_.6fr]">
              <div className="border-b border-[#ded5cd] p-5 lg:border-b-0 lg:border-r lg:p-7">
                <div className="grid gap-3 sm:grid-cols-3">{SIGNALS.map(([value, label, note]) => <div key={label} className="rounded-[18px] border border-[#ded5cd] bg-white p-4"><div className="font-serif text-3xl tracking-[-.04em]">{value}</div><div className="mt-1 text-sm font-bold">{label}</div><div className="mt-3 text-[11px] text-[#8b7d83]">{note}</div></div>)}</div>
                <div className="mt-6"><div className="mb-3 flex items-center justify-between"><h4 className="text-sm font-bold">Today’s appointment book</h4><Link to="/login" className="text-xs font-bold text-[#9b4d5c]">Open schedule →</Link></div><div className="space-y-2">{DAY_EVENTS.map(([time, service, client, status]) => <div key={time} className="grid grid-cols-[54px_1fr_auto] items-center gap-3 rounded-[14px] bg-white px-3 py-3 sm:grid-cols-[70px_1fr_130px_auto]"><span className="text-xs font-bold text-[#a14e5e]">{time}</span><span className="truncate text-sm font-bold">{service}</span><span className="hidden text-xs text-[#7a6d73] sm:block">{client}</span><span className="rounded-full bg-[#f0e8e4] px-2.5 py-1 text-[10px] font-bold text-[#6c5961]">{status}</span></div>)}</div></div>
              </div>
              <aside className="p-5 lg:p-7"><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-full bg-[#ead6cf] text-[#9b4d5c]"><SparkIcon /></div><div><div className="text-xs font-bold uppercase tracking-[.14em] text-[#8c7c82]">Zac intelligence</div><div className="text-sm font-bold">3 useful signals</div></div></div><div className="mt-6 space-y-4"><Insight label="Revenue opportunity" body="Six colour clients are due to rebook this week." action="Review clients" /><Insight label="Stock risk" body="Blondor will fall below cover after today’s bookings." action="Prepare order" /><Insight label="Team moment" body="Amelia is one service away from her weekly target." action="View performance" /></div></aside>
            </div>
          </div>
        </div>
      </section>

      <section id="ecosystem" className="mx-auto max-w-[1240px] px-5 py-20 lg:px-8 lg:py-28"><div className="rounded-[32px] bg-[#dc7f69] p-7 sm:p-10 lg:p-14"><div className="grid gap-10 lg:grid-cols-[.8fr_1.2fr] lg:items-center"><div><Eyebrow>Built as an ecosystem</Eyebrow><h2 className="mt-5 font-serif text-[40px] leading-[1.02] tracking-[-.035em] text-[#2c1c29] sm:text-[50px]">One business.<br />Every important signal.</h2><p className="mt-5 max-w-md text-sm leading-6 text-[#563b41]">Clients, appointments, formulas, products, payroll, and performance share the same operational context—so growth does not create more fragmentation.</p></div><div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{['Online booking', 'Client relationships', 'Team & rota', 'Colour intelligence', 'Inventory & orders', 'Payroll & performance'].map((item, index) => <div key={item} className="flex min-h-[112px] flex-col justify-between rounded-[20px] border border-[#6b3f45]/15 bg-[#f8e9de]/70 p-4"><span className="text-[10px] font-bold text-[#84525a]">0{index + 1}</span><span className="text-sm font-bold leading-5 text-[#34232b]">{item}</span></div>)}</div></div></div></section>

      <section className="mx-auto max-w-[1240px] px-5 pb-20 lg:px-8 lg:pb-28"><div className="relative overflow-hidden rounded-[32px] bg-[#fffaf4] px-6 py-14 text-center shadow-[0_15px_50px_rgba(67,43,53,.08)] sm:px-12 sm:py-20"><div className="absolute left-1/2 top-0 h-40 w-96 -translate-x-1/2 rounded-full bg-[#e99a85]/20 blur-3xl" /><div className="relative"><Eyebrow>A better way to operate</Eyebrow><h2 className="mx-auto mt-5 max-w-3xl font-serif text-[42px] leading-[1.04] tracking-[-.04em] sm:text-[58px]">Build a salon that feels<br /><span className="italic text-[#9b4d5c]">as good as it performs.</span></h2><p className="mx-auto mt-6 max-w-xl text-[15px] leading-7 text-[#6c6066]">Start with the essentials. Add intelligence as your business grows. Keep your team and your clients in one thoughtful experience.</p><div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row"><Link to="/owner/onboarding" className="inline-flex items-center justify-center gap-2 rounded-full bg-[#392032] px-7 py-3.5 text-sm font-bold text-white">Start free <ArrowIcon /></Link><Link to="/book/location" className="inline-flex items-center justify-center rounded-full border border-[#cfc0b6] px-7 py-3.5 text-sm font-bold text-[#3a3035]">Experience client booking</Link></div></div></div></section>

      <footer className="border-t border-[#dcd0c6] bg-[#ede4da]"><div className="mx-auto max-w-[1240px] px-5 py-12 lg:px-8"><div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]"><div><BrandLogo className="h-7" /><p className="mt-4 max-w-xs text-sm leading-6 text-[#70636a]">The connected operating system for ambitious salon and beauty businesses.</p></div><FooterGroup title="Product" links={[['Platform', '#platform'], ['Intelligence', '#intelligence'], ['Book appointment', '/book/location']]} /><FooterGroup title="Company" links={[['Create account', '/owner/onboarding'], ['Log in', '/login'], ['Support', '/support']]} /><div><div className="text-[11px] font-bold uppercase tracking-[.16em] text-[#8a7b81]">Get the app</div><div className="mt-4 flex flex-col gap-2 text-sm font-semibold text-[#5d5057]"><a href={sheerAppIosUrl}>App Store ↗</a><a href={sheerAppAndroidUrl}>Google Play ↗</a></div></div></div><div className="mt-12 flex flex-col gap-3 border-t border-[#d4c7bd] pt-6 text-xs text-[#84767c] sm:flex-row sm:justify-between"><span>© {new Date().getFullYear()} Service SaaS. All rights reserved.</span><Link to="/privacy-policy">Privacy policy</Link></div></div></footer>
    </main>
  );
}

function Eyebrow({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) { return <div className={`text-[11px] font-bold uppercase tracking-[.18em] ${dark ? 'text-[#e99a85]' : 'text-[#a6535e]'}`}>{children}</div>; }
function Insight({ label, body, action }: { label: string; body: string; action: string }) { return <div className="border-b border-[#ddd1c9] pb-4"><div className="text-[10px] font-bold uppercase tracking-[.14em] text-[#a0525e]">{label}</div><p className="mt-1.5 text-sm leading-5 text-[#5f5359]">{body}</p><button type="button" className="mt-2 text-xs font-bold text-[#392032]">{action} →</button></div>; }
function FooterGroup({ title, links }: { title: string; links: [string, string][] }) { return <div><div className="text-[11px] font-bold uppercase tracking-[.16em] text-[#8a7b81]">{title}</div><ul className="mt-4 space-y-2.5">{links.map(([label, href]) => <li key={label}><Link to={href} className="text-sm font-semibold text-[#5d5057] hover:text-[#2c1c29]">{label}</Link></li>)}</ul></div>; }
function ArrowIcon() { return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8h9M9 4.5 12.5 8 9 11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function CheckIcon() { return <span className="grid h-5 w-5 place-items-center rounded-full bg-[#ead6cf] text-[#9b4d5c]"><svg aria-hidden="true" width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="m3 6 2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span>; }
function SparkIcon() { return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M10 2.5 11.4 7l4.1 1.5-4.1 1.5L10 14.5 8.6 10 4.5 8.5 8.6 7 10 2.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>; }
