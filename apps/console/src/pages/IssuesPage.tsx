// Issue(/console/issues): 최근 Cycle 들의 실패를 서명(errorCode + 정규화한 실패 지시)으로 묶은 것. 사람이 분류·메모·티켓을 단다.
import { useEffect, useRef, useState } from 'react';
import type { Api, IssueCategory, IssueView } from '../api.ts';
import { Failure, Link, useLoad } from '../components.tsx';
import { caseHref } from '../route.ts';

/** 볼 Cycle 수(안정성 이력과 같은 범위) */
export const ISSUE_CYCLES = 20;
export const CATEGORY_LABEL: Record<IssueCategory, string> = { product: '제품 결함', test: '테스트 결함', infra: '인프라', flaky: '불안정' };

export function IssuesPage({ api }: { api: Api }) {
  const load = useLoad(() => api.issues(ISSUE_CYCLES), [api]);
  // 케이스 상세의 "같은 원인의 Issue" 링크(/console/issues#<id>)로 오면 그 행을 강조하고 보이게 한다
  const targetId = window.location.hash.slice(1);
  if (load.state === 'loading') return <p className="muted">불러오는 중…</p>;
  if (load.state === 'error') return <Failure message={load.message} />;
  if (load.data.length === 0) return <p className="muted">최근 {ISSUE_CYCLES} Cycle 에 실패가 없음</p>;
  return (
    <>
      <p className="muted">최근 {ISSUE_CYCLES} Cycle 의 실패를 원인 서명(errorCode + 실패 지시에서 숫자·ref·기다린 시간을 뺀 것)으로 묶었다. 같은 Issue 의 새 실패는 여기에 붙는다.</p>
      <table className="table">
        <thead><tr><th>원인</th><th>코드</th><th>발생</th><th>테스트</th><th>최근</th><th>분류</th><th>메모·티켓</th><th /></tr></thead>
        <tbody>{load.data.map((i) => <IssueRow key={i.id} api={api} issue={i} target={i.id === targetId} />)}</tbody>
      </table>
    </>
  );
}

function IssueRow({ api, issue, target }: { api: Api; issue: IssueView; target: boolean }) {
  const row = useRef<HTMLTableRowElement>(null);
  useEffect(() => { if (target) row.current?.scrollIntoView?.({ block: 'center' }); }, [target]);
  const [category, setCategory] = useState<string>(issue.category ?? '');
  const [note, setNote] = useState(issue.note ?? '');
  const [ticketUrl, setTicketUrl] = useState(issue.ticketUrl ?? '');
  const [status, setStatus] = useState<string>('');
  const last = issue.occurrences[0];
  const save = async () => {
    setStatus('저장 중…');
    try {
      await api.triage(issue.id, { category: (category || null) as IssueCategory | null, note, ...(ticketUrl ? { ticketUrl } : {}) });
      setStatus('저장됨');
    } catch (err) { setStatus(`저장 실패: ${err instanceof Error ? err.message : String(err)}`); }
  };
  return (
    <tr ref={row} id={`issue-${issue.id}`} className={target ? 'issue-target' : undefined} aria-current={target ? 'true' : undefined}>
      <td className="instruction">{issue.summary || <span className="muted">(실패 스텝 없음)</span>}</td>
      <td><code>{issue.errorCode}</code></td>
      <td>{issue.count}</td>
      <td>{issue.tests.join(', ')}</td>
      <td>{last ? <Link to={caseHref(last.cycleId, last.testId, last.targetId)} title={`최근 ${last.build} · ${last.testId} · ${last.targetId}`}>{last.build}</Link> : '—'}</td>
      <td>
        <select aria-label="분류" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">미분류</option>
          {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {issue.suggested ? <div className="muted">추천: {CATEGORY_LABEL[issue.suggested]}</div> : null}
      </td>
      <td>
        <input aria-label="메모" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        <input aria-label="티켓 주소" value={ticketUrl} onChange={(e) => setTicketUrl(e.target.value)} placeholder="https://…" />
        {issue.ticketUrl ? <a href={issue.ticketUrl} target="_blank" rel="noreferrer">티켓</a> : null}
      </td>
      <td><button type="button" onClick={() => void save()}>저장</button> <span className="muted">{status}</span></td>
    </tr>
  );
}
