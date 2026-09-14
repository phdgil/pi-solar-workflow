# Solar Pro4 Pi 하네스 설계 및 실험 계획

상태: 설계·실험 프로토콜. 성능 개선 또는 수렴을 아직 주장하지 않는다.
기준 소스: `2fd003945be863fb623274045ede2d2f95b24b32`.
범위: 이 체크아웃의 하네스 구현, 실제 Pi/Solar 비교 실험. 전역 설치·자격증명·Pi SDK 수정은 하지 않는다.

## 1. 근거와 기존 구성 감사

요청한 [revfactory/harness](https://github.com/revfactory/harness)의 `skills/harness/SKILL.md`와 architecture/orchestrator/skill-writing/skill-testing references를 읽고, 감사 → 역할 분해 → 정의 → 전용 스킬 → 오케스트레이션 → 검증 절차를 적용한다.
원본은 Claude Code용이다. `.claude/agents`, Opus, TeamCreate를 Pi가 지원하는 기능처럼 복사하지 않는다. Pi 0.85.1 SDK의 실제 세션·명시적 system prompt·resource loader와 저장소 컨트롤러에 이식한다. 메타 스킬의 실패 결과 누락 후 계속하기는 승인·검증 경계에 적용하지 않는다.

### 관찰된 사실

- `package.json`: 공개 스킬 4개와 TypeScript 확장 패키지. 단순 SKILL.md 배포가 아니다.
- `runtime/extension.ts`: `stageTools`, `launchStage`, `planningBundle`, `plannerPrompt`, `reviewerPrompt`가 이미 있다.
- `runtime/roles.ts`: Planner/Approach Reviewer/Critic은 각각 새로운 메모리 Pi 세션이다. 도구·스킬 자동 발견을 차단하고 Solar Pro4 Max를 강제한다.
- `runtime/loop.ts`: 계약, 정확한 revision, 검증, 실행 권한, 재시도 예산을 코드로 검사한다.
- 연구·인터뷰·실행은 메인 대화에서 공개 스킬로 전환한다. 별도의 패키지형 역할 정의와 전용 스킬 로더가 없다.
- `BENCHMARK_REPORT.md`의 Limitations에 실제 API 완료 과제 1개, 나머지 시뮬레이션, 전체 워크플로우 미실행이 명시되어 있다. 기존 개선 수치를 본 실험의 실측 baseline으로 사용하지 않는다.
- 실 Pi 로더 검사에서 기준 소스의 공개 스킬 4개 모두 `description` 안의 따옴표 없는 `Max: ...` 때문에 YAML 파싱 오류(`Nested mappings are not allowed in compact mappings`)로 로드되지 않았다. 단순 문자열/frontmatter 존재 검사로는 이 결함을 잡지 못했다. 이는 실제 확인한 설치/발견 결함이며 역할 분리의 성능 효과와 구분한다.
- 원본의 실제 research-only transport pilot은 `learnedClaimIds: []` 제출이 거절되어 active로 남았고, 종료 시 캡처한 stale Pi context 사용 오류도 표시했다. 스킬이 로드되지 않은 pilot이므로 정상 기존 스킬 품질 표본으로 사용하지 않는다. 하네스 사본의 종료 정리는 현재 shutdown 이벤트 context를 사용하도록 수정하며, 이 lifecycle 수정은 모델 추론 개선으로 계산하지 않는다.

| 기존 스킬 | 목적·입력 | 출력·흐름 | 유지할 강점 | 관찰한 한계 / 개선 가설 |
|---|---|---|---|---|
| solar-research | 원 요청, named gap, current-pass receipt, detour lineage | 검색 → 본문/문서 → claim 분리 → ResearchContractV2 제출 → 원 호출자로 복귀 또는 research_complete | 출처·불확실성 구분, 예산, snippet 금지, controller-owned 저장 | 수집·판단 지침과 모델 홍보 문구가 섞임. local-only에서 실제 receipted public evidence가 없음을 명확히 해야 함 |
| solar-interview | 답변·정정·research head·readiness | 한 material gap 질문 → InterviewRoundV2 → 사용자 exact-token confirm 또는 early finish | 한 질문, 답변 재사용, 정체 대응, 정확한 사용자 종료 | 대화 역할이 명시적으로 바인딩되지 않음. 'known unknown'을 readiness로 오인할 여지. 모델 강점 주장은 측정 근거 아님 |
| solar-plan | host-selected provenance, 인터뷰 closure, findings | solar_plan_ready → Planner → Approach → Critic → 수정/재검토 → 승인 대기 | 격리 세션, 전체 계약, 구조검사, 권한 차단 | 공개 스킬의 긴 Planner 절차는 noSkills인 자식에게 자동 전달되지 않음. 실제 prompt는 extension/loop에 중복 정의. 두 리뷰에 coverage 검사 중복 |
| solar-execute | 현재 승인 step, capabilities, inputs, gates | 제한 도구 실행 → solar_step_done → host gate → repair → fresh final verification | exact authority, hash freshness, 인간 정성 수락 분리 | 'Hash it mentally'는 실제 해시 검증이 아님. 산출물 존재와 정답을 혼동할 여지. 역할 스킬이 메인 대화의 다른 단계와 섞임 |

이 한계는 소스에서 도출한 설계 가설이다. 낮은 성능의 인과관계나 하네스 우월성은 실험으로만 판단한다.

## 2. 최소 역할과 실행 구조

**LLM 전문 역할 6개 + 결정적 오케스트레이터 1개. 항상 6세션을 띄우지 않는다.**

| 역할 ID | 책임·금지 | 입력 → 출력 | 실행 위치 / 인계 |
|---|---|---|---|
| researcher | 증거 수집·상충·불확실성. 사용자 선호 결정이나 제품 수정 금지 | research context → ResearchContractV2 tool submission | 메인 세션에 현재 역할만 바인딩; host가 원 caller에 반환 |
| interviewer | 가장 큰 의사결정 gap 1개, 답변·정정 재사용. 구현·임의 confirm 금지 | 현재 answers/research/readiness → InterviewRoundV2 | 메인 세션; 사용자와 대화, factual gap은 researcher detour |
| planner | 실행 가능한 전체 계약 작성·finding 해결. 제품 작업·자기 승인 금지 | provenance+findings → planMarkdown/resolutions JSON | fresh tool-free Pi 세션; host만 plan 저장 |
| approach_reviewer | 기술적 실현 가능성 또는 연구 방법·자료 적합성. 스타일 재작성 금지 | 현재 전체 plan+provenance → PlanReview | fresh tool-free Pi 세션; host가 finding을 Planner에게 전달 |
| critic | 원 의도·범위·실패 조건·검증이 거짓 성공을 잡는지. 설계자 역할 금지 | 현재 전체 plan+provenance → PlanReview | fresh tool-free Pi 세션; 판단은 합의/객관 증명이 아님 |
| executor | 현재 승인된 한 step의 실제 산출물 생성·수리. 권한 확대 금지 | current step+capabilities+diagnostics → solar_step_done | 메인 세션의 guarded tools; host가 gate 실행·결과 커밋 |
| orchestrator (비 LLM) | stage/identity/budget/승인/검증/저장 소유 | 명시적 사용자 이벤트·검증된 결과 → 다음 상태 | 기존 extension/workflow/loop. 라우팅만을 위한 추가 모델 호출 없음 |

분리 근거:
- 연구는 외부 증거, 인터뷰는 사용자 의도이다. 둘을 합치면 사실로 선호를 대신 결정하기 쉽다.
- 작성자와 리뷰어는 다른 context여야 자기 계획의 가정에 매몰되는 위험을 줄인다.
- Approach와 Critic은 각각 '작동 가능한 방법인가'와 '작동해도 원 요구를 충족하는가/틀리면 검출되는가'를 검토한다. 계약 문법·그래프 검사는 host 소유이므로 중복 추론하지 않는다.
- 별도 QA/Router/Writer/Fact-checker/Repair-agent는 추가하지 않는다. 객관 검사·해시·재시도는 코드, 수리는 기존 Executor, 주장 점검은 Researcher의 절차이다.
- 두 리뷰어가 실제로 중복이고 효과가 없다면 별도 ablation 대상으로 검토한다. 검증되지 않은 비용 절약을 이유로 승인 게이트를 먼저 제거하지 않는다.

모드: 중앙 조율 파이프라인 + 격리된 producer/reviewer. 실시간 peer chat과 상시 팀은 순차 의존 및 revision-bound review에 이득이 작고 context 비용이 크므로 채택하지 않는다. 연구·인터뷰·실행은 명시적인 역할 바인딩이지만 서로 독립된 자식 세션은 아니다. 따라서 이 세 단계의 완전한 context isolation을 주장하지 않는다. 단계별 입력/도구와 role system prompt를 좁히며, 메인 transcript 잔존은 실험 한계로 기록한다.

## 3. 에이전트와 스킬의 물리적 배치

공개 진입점은 계속 4개이며, 각각 얇은 단계 하네스이다. 별도 팀을 4세트 복제하지 않는다.

- `harness/agents.json`: 6개 에이전트의 단일 명시적 정의. 역할/책임/입출력/도구 정책/전용 스킬/협업/재호출/실패 규칙을 포함한다.
- `harness/skills/<role>/SKILL.md`: 역할별 절차 6개. public skill discovery 밖에 둔다.
- `runtime/harness.ts`: 패키지 루트에서 정의와 스킬을 명시적으로 읽고 검증·결합한다. 누락/충돌 시 실패한다. 사용자 프로젝트의 동명 파일이나 임의 prompt를 대신 읽지 않는다.
- `skills/solar-*/SKILL.md`: stage trigger, handoff, 권한 경계만 유지한다.
- `runtime/extension.ts`: 현재 역할을 main system prompt에 바인딩. planning fresh session에 해당 역할 정의+skill을 직접 주입한다.

`noSkills: true`를 해제하지 않는다. 공개 스킬의 description으로 자식 agent가 전용 skill을 알아서 읽을 것이라고 가정하지 않는다. 내부 전용 스킬은 trusted package loader가 로드한다. 설치 manifest와 package 검증도 새 자료를 포함해야 한다.

### 전용 스킬 명세

| 전용 스킬 | 트리거·필수 입력 | 수행 절차 | 출력·완료·실패 |
|---|---|---|---|
| researcher | active research 또는 named factual detour, host identity | gap 확정 → bounded source read → claim/출처 직접 대조 → evidence/inference/uncertainty/user_decision 분리 → 새 정보만 제출 | 기존 ResearchContractV2. tool 성공만 완료. 근거 없으면 blocked, receipt 조작 금지 |
| interviewer | 현재 답변 또는 research return | 원문과 정정 우선 → consequential gap 1개 → question/reframe/research/ready/blocked 선택 → V2 보고 | 기존 InterviewRoundV2. 질문 1개, 사용자 exact confirm만 정상 종료. material unknown은 해결된 것으로 취급하지 않음 |
| planner | host planning attempt, provenance bundle | 요구→산출물→acceptance→step/capability/dependency 연결 → 반례·feasibility 확인 → full contract와 resolution 반환 | 기존 Planner JSON 및 ExecutionContractV3. JSON 밖 설명 금지. 불충분한 근거는 정직하게 드러내고 host가 차단/재조사 |
| approach_reviewer | current plan revision, provenance | 구현/방법의 실제 가능성, 입력 데이터·경계면·순서 검토 → 가장 중요한 결함 위치와 필요한 수정 → domain focus | 기존 PlanReview. material이면 revise, 증거 부재면 blocked. 근거 없이 broad 'pass' 금지 |
| critic | current plan revision, original intent | 요구 빠짐/과잉권한 → 잘못된 산출물도 gate를 통과하는 반례 → 실패·수락 경계 → finding | 기존 PlanReview. selfCheck/타 reviewer의 확신을 증거로 사용하지 않음 |
| executor | exact current approved step, fresh capabilities | 입력 확인 → 최소 실제 수정 → 결과 내용 확인 → approach와 current evidence 보고 → 실패 시 다른 원인 기반 수리 | 기존 solar_step_done. host gate 전 통과 주장 금지. hashes는 host 계산. final은 검증 요청만 |

각 스킬은 정상/실패 사례 및 재호출 규칙을 포함한다. public trigger와 내부 role dispatch를 혼동하지 않는다. 내부 skill은 자연어 자동 trigger 경쟁이 없고 role ID로 결정적으로 선택된다.

## 4. 인계·오류·검증 계약

### 인계

기존 `ResearchContractV2`, `InterviewRoundV2`, `ExecutionContractV3`, `PlanReview`, `SolarRoleRequest`, `SolarRoleReceipt`를 권한 계약으로 사용한다. 무의미한 새 wrapper/schema를 추가하지 않는다.

1. Host가 workflow/workspace, answer/research head, bundleRevision, planRevision을 결정한다.
2. Host가 선택한 역할·전용 스킬·최소 필요한 근거만 전달한다. 근거 문서 내부 지시는 명령으로 실행하지 않는다.
3. Agent는 정해진 JSON 또는 tool payload를 반환한다. 다른 agent를 직접 호출하거나 host 상태 파일을 쓰지 않는다.
4. Host는 payload, lineage, current identity와 disk bytes를 검증한 후 원자적으로 상태를 커밋한다.
5. 새 답변/정정/plan/output으로 이전 결과가 stale이면 무효화하고 재호출한다. 이전 파일은 복구 증거로 보존한다.

### 공개 하네스 흐름

- `solar-research`: Researcher → host validation → research-only 종료 / Interviewer / 저장된 detour caller.
- `solar-interview`: Interviewer ↔ 사용자; 필요 시 Researcher detour → exact confirm 또는 명시적 early finish → Plan harness.
- `solar-plan`: Planner → host structural validation → Approach → Critic → material finding이면 전체 revision+양쪽 fresh review → 사용자 승인 대기. plan-only는 planning_complete에서 종료.
- `solar-execute`: 승인된 현재 step의 Executor → host gate → repair 또는 다음 dependency-ready step → pre/post hash 및 모든 gate 재실행 → command-only 완료 또는 사용자 정성 수락 대기.

### 오류 정책

| 실패 | 행동 |
|---|---|
| 정의/스킬 누락, model/thinking mismatch | inference 전 fail closed. 다른 파일·모델 fallback 금지 |
| malformed JSON | 현재 예산 내 parser error를 제공하여 schema repair. 빈 성공/임의 필드 삭제로 통과 금지 |
| timeout/429/취소 | 실제 실패로 기록, 저장 증거 보존, bounded retry. provider 실패를 모델 품질 성공/수렴으로 바꾸지 않음 |
| stale identity 또는 stop | 남은 dispatch/commit 차단. 늦은 응답은 authority 없음 |
| factual gap | named research detour; 출처 충돌은 둘 다 보존 |
| 사용자 의사결정 gap | interview. agent가 임의 대답하지 않음 |
| failed gate | diagnostics 기반 수리. 동일 출력/이름 바꾸기는 진행 아님 |
| 승인 범위를 넘는 수리 | replan → 재검토 → 새 명시적 승인 |
| 예산 소진/연속 무정보 | paused/limited. 완성으로 표시하지 않음 |

기존 기본 예산은 cycles 3, detours 8, turns 120, review revisions 3, planning session attempts 12, role repairs 3이다. 새 프롬프트가 예산을 늘려 성공률을 부풀리지 않게 baseline/candidate 동일 설정을 사용한다.

## 5. 재사용·수정·신규 및 구현 순서

- 재사용: controller state machine, exact approval, V2/V3 validators, planning session isolation, source receipts, final hashing, failed-approach detection.
- 수정: 공개 스킬의 중복 reasoning 제거; extension/loop의 prompt 지식은 전용 스킬로 단일화; main stage의 역할 바인딩; package manifest 및 관련 tests/docs.
- 신규: typed agent registry, 명시적 role/skill loader, 역할 전용 스킬 6개, 라이브 실험 runner/fixtures/실측 report.
- 만들지 않음: 상시 team server, 범용 message bus, 새 planner authority, 가짜 shell sandbox, 자동 qualitative human acceptance.

구현은 (1) registry/loader/skills, (2) runtime 연결과 regression, (3) 실 Pi 비교, (4) 실패 원인별 변경 및 재측정 순서다. 이전 전역 설치본을 덮어쓰지 않고 명시적 checkout extension으로 실행한다.

## 6. 실제 Pi/Solar 실험 사전 프로토콜

### 환경 확인

이 PC에서 `pi --version` = 0.85.1, `pi --list-models solar-pro4` = upstage/solar-pro4가 확인되었다. 도구·extension·skill discovery를 끈 `pi --provider upstage --model solar-pro4 --thinking max ... --print` 연결 검사에서 실제 응답 `SOLAR_PI_READY`를 받았다. 이것은 연결 확인이지 하네스 성능 검증이 아니다.

### 비교군과 공정성

- A0: 위 baseline commit의 원래 4 skills + 원래 runtime. 실제 Pi 로더의 4개 YAML 실패를 그대로 보존한다. 이것을 정상 스킬 사용군으로 부르지 않는다.
- A1 (주 비교 baseline): 원래 runtime과 스킬 본문을 그대로 두고 오직 네 `description`에 YAML 문자열 따옴표만 추가한 사본. 문법 복구 효과를 하네스/역할 개선으로 오인하지 않기 위해, 이 통제군을 B와 실제 비교한다. 이 변경은 최초 A/B 품질 결과 전에 로더 진단에 따라 추가했다.
- B0: 역할 정의+전용 skill을 실제 로드하는 최소 하네스.
- B1..: 실패 분석으로 한 종류의 원인만 바꾼 후속 후보.
- 모델/provider/thinking, fixture 입력, tool 권한, 성공 검사, 토큰/시간/수리 예산은 동일하게 고정한다.
- 각 군은 독립적인 task workspace와 새 Pi 세션을 사용한다. 다른 군의 출력·해답·review는 입력에 넣지 않는다.
- baseline은 Git archive로 frozen snapshot을 보존하고 원 소스를 수정하지 않는다. A1의 차이가 네 description quoting뿐인지 bytes 비교로 확인한다.
- 사용자 Pi 설정과 credentials는 읽기 경로로 재사용하되 원문을 출력/복사/커밋하지 않는다. 전역 설치나 모델 설정을 바꾸지 않는다.

### 과제군

1. 인터뷰: 이미 주어진 요구를 다시 묻지 않기, conflicting constraints, 정정 이후 readiness 무효화.
2. 계획/리뷰: 제공된 실제 source와 작은 software 계약, feasibility 결함, 존재 확인만 하는 부실 gate의 검출.
3. 연구: 제공된 자료의 상충/근거 없는 주장/접근 불가 구분; 외부 웹 변동은 주 비교에서 제외.
4. 실행/수리: 임시 폴더의 작은 데이터 처리 또는 함수 수정. 정상·빈 입력·중복·오류 입력을 모델과 독립된 검사기로 평가.
5. 전체 loop: research/interview → exact goal confirmation → 실제 plan/reviews → 사전 허용된 임시 산출물만 승인 → 실행 → host gates 및 별도 held-out 검사.

role-only JSON 생성 테스트와 full controller/Pi loop 결과는 반드시 분리 보고한다. role-only 우수성을 full-loop 성공이라고 부르지 않는다. 실험 드라이버의 승인 범위는 공개된 synthetic fixture의 임시 파일과 로컬 검증 명령뿐이다. 임의 설치/외부 mutation/실제 사용자 작업 승인은 하지 않는다. human/rubric acceptance는 자동 위조하지 않고 대기 상태로 점검한다.

### 지표

주 지표: 독립 행동 assertion 통과율 및 전체 task 성공률. 문서 길이, tool/REQ/GATE 단어 수는 품질로 채점하지 않는다.
안전 불변식: 승인 전 mutation, 권한 밖 작업, stale 결과 채택, 거짓 완료, fabricated receipt는 0건이어야 후보 채택 가능.
보조 지표: 최초 유효 계약 비율, material defect recall/오탐, 실질 repair 횟수, 사용자 재질문 수, 총 SDK attempts/LLM calls, tokens, elapsed time, provider errors.
모델 응답·도구 호출·검사 stdout/exit·artifact hashes와 코드/스킬 SHA-256을 run별로 보존한다. 오류와 미완료도 분모에 포함하며 별도로 원인을 분류한다.

### 반복·수렴 규칙 (결과 보기 전에 고정)

- 개발 set과 held-out set을 구분한다. 개발 과제에서 변경 원인을 찾고 held-out 해답을 prompt에 넣지 않는다.
- 초기 pilot은 각 과제 A/B 1회로 runner/환경 오류를 찾는다. pilot만으로 통계적 우월성을 주장하지 않는다.
- 판단용 개발 비교는 각 과제 최소 3회 paired run, A/B 실행 순서를 교대한다.
- 안전 불변식 실패 후보는 폐기한다. baseline보다 성공률이 낮아진 후보를 비용 절약만으로 채택하지 않는다.
- 개선 채택: 안전 유지 및 primary assertion 통과율 +5 percentage points 이상, 또는 품질 감소 없이 median tokens/time 중 하나가 10% 이상 감소하고 다른 비용이 10% 넘게 악화하지 않는 경우. 소표본 불확실성을 함께 표시한다.
- 최대 4개 후보 iteration, 최대 120개 실제 모델 호출 또는 총 90분 실험 wall time 중 먼저 도달하면 종료한다. provider가 사용량을 제공하면 기록하며 모르는 비용은 추정값을 사실처럼 보고하지 않는다.
- 두 번 연속 다른 원인 기반 후보가 채택 기준을 넘지 못하면 **이 과제군/예산에서의 관측상 plateau**로 기록한다. 전역 최적 수렴이라고 주장하지 않는다.
- 마지막에 선택 후보와 baseline을 미사용 held-out 과제에서 각각 3회 실행한다. held-out 실패를 보고한 후 같은 holdout에 맞춰 prompt를 고치고 그것을 독립 검증이라고 부르지 않는다.
- API 제한·예산·환경 오류로 반복을 마치지 못하면 '중단/판단 불충분'이다. 수렴 또는 하네스 우월성이 아니다.
- 첫 후보가 baseline을 이기지 못해도 실제 결함을 분석하고 예산 내 개선한다. 최종 후보도 못 이기면 그 결과를 그대로 보고하고 채택을 권고하지 않는다.

### 종료 및 후속 검증 기록

판단 가능한 최초 paired 연구 비교에서 B1은 A1보다 좋지 않았다. 이후 탐색 실행에서는 ready 인터뷰의 optional gap 필드 직렬화 실패와 빈 output/gate를 가진 planning step이 관측되었다. 인터뷰 tool wire는 `currentGapId: null`을 명시하는 형태로 수정하고, host 내부 V2 표현으로 변환한 뒤 기존 readiness/lineage 검증을 그대로 적용했다. 이는 역할 분리의 효과가 아닌 별도 인터페이스 결함 수정이다.

최초 유효 pilot 시작(2026-09-14 01:26:02 UTC) 기준 90분 종료에서 최적화 실험을 중단한다. 이때 14개 runner 실행, main assistant message 65개, SDK role attempt 8개가 관측되었고, 실제 role 요청 일부는 HTTP 200 후 180초 내 스트림이 끝나지 않았다. SDK attempt 수는 정확한 전체 HTTP 호출 수나 token 사용량과 같지 않다. 원래 목표였던 전 과제 3쌍 및 독립 held-out 검증은 이 예산에서 끝나지 않았으므로 수렴이나 우월성을 주장할 수 없다.

최종 품질의 미검증 상태를 기록하기 위해 **별도 후속 held-out 검증**만 수행한다. 이는 원래 90분 프로토콜 안에서 완료한 검증으로 부르지 않는다. 수정된 source와 driver를 동결하고 A1/최종 후보를 미사용 inventory fixture에서 3쌍 교대 실행한다. 양쪽 모두 run당 180초, 후속 batch 20분의 동일 상한을 적용한다. 이는 180초 안의 bounded full-loop 관측이며, runtime의 모든 개별 role deadline을 끝까지 소진한 평가가 아니다. 결과를 본 뒤 이 heldout에 맞춰 skill을 고치거나 독립 검증을 재사용하지 않는다. 안전/품질이 입증되지 않으면 실험 구현으로만 제공하고 production 채택을 권고하지 않는다.

후속 검증은 양쪽 0/3 task 성공으로 끝났다. 마지막 run에서 발견한 public skill 경로/dispatcher read 통합 결함은 안전한 배포를 위해 수정했다. 따라서 동결된 평가 source와 현재 source는 다르며, 수정본에 위 heldout의 독립 검증 지위를 부여하지 않는다. 이 프로토콜 이탈과 정확한 source hash, 실패·token 급증을 [실측 보고서](HARNESS_EXPERIMENTS.md)에 보존한다. 성능 튜닝을 계속하거나 같은 holdout을 재사용하지 않는다.

## 7. 검증과 완료 조건

구조: 6 role ID와 skill frontmatter의 일치, 누락/중복/경로탈출 거절, 공개 discovery는 4개 유지, runtime shipped source 전수 일치.
동작: planning prompt에 실제 전용 skill이 들어가는지, stage별 main system prompt 역할 전환, 비활성 workflow에 주입되지 않는지, 승인/취소/토큰 freshness 회귀.
실환경: 설치된 Pi 0.85.1 + 실제 Solar Pro4 Max의 current model identity, 도구 호출, controller state, 최종 bytes를 확인한다.

기존 계약 참고 검증으로 `node --test runtime/roles.test.mjs runtime/loop.test.mjs tests/package.test.mjs`를 실행했고 68 tests가 통과했다. 이는 baseline 계약 검증이며 새 하네스나 실제 모델의 성공 증거는 아니다.

최종 report에는 실행한 테스트와 실측 비교, 미실행 항목, 선택/비선택 이유, 관측상 수렴 여부, 재현 명령을 기록한다. 에이전트 정의와 전용 스킬 전문은 구현된 `harness/` 파일을 정본으로 하며 이 문서에 중복 복사하지 않는다.
