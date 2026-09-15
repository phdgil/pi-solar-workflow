# Pi / Solar Pro4 하네스 실측

## 판정

**실험 구현이다. 하네스 우월성, 고품질 전체 실행, 수렴은 입증되지 않았다. production 채택을 권고하지 않는다.** 단위/통합 회귀 통과는 실제 모델의 task 성공과 구분한다.

환경은 Windows, Node 24.18.0, 설치된 Pi 0.85.1, `upstage/solar-pro4`, thinking `max`였다. 실제 응답의 model 표기는 `solar-pro4-260806`이었다. 로컬 transport 진단은 `api.upstage.ai`의 실제 HTTP 200/스트림 종료를 확인했다. 사용자 설정/키는 변경·복사·커밋하지 않았고 전역 설치본도 바꾸지 않았다.

## 비교 통제

- A0: 원본 commit `2fd003945be863fb623274045ede2d2f95b24b32`. 네 공개 SKILL description의 따옴표 없는 `Max: ...` 때문에 실제 Pi YAML loader가 네 스킬 모두를 거절했다.
- A1: A0의 네 description에 따옴표만 추가. 본문/runtime은 그대로다. 실제 loader가 네 스킬을 모두 경고 없이 발견했고, Git no-index 비교는 정확히 4 files / 4 lines만 바뀐 것을 확인했다.
- B0: 여섯 역할 정의와 전용 스킬을 실제 연결한 첫 하네스.
- B1: 로컬 자료를 public source로 직렬화하는 오류를 바로잡는 branch/example.
- B2: 직접 명명된 파일을 먼저 read하도록 하고 중복 연구 지침을 축약.
- B3: answer ID와 SHA-256 namespace 및 ready 직렬화 지침을 명확히 함.
- C0: 모델 wire의 `currentGapId`를 명시적 null 또는 nonempty ID로 정규화. 기존 domain V2 readiness/lineage 검증은 유지했다. 이 효과는 역할 분리의 효과가 아니다.
- C1 및 최종 수정: 빈 outputs/gates의 read-only planning step을 만들지 않도록 명확히 함.

초기 pilot과 마지막 source는 서로 다르며, pilot을 최종 source의 성공 증거로 재사용하지 않는다. 모든 비교는 실제 API 호출이고, `tests/pi-smoke.mjs`의 scripted loopback provider와 분리했다.

## 판단 가능한 연구 비교

같은 `research-local` fixture, 같은 driver/grader fingerprint, 각 군 새 workspace/session, 순서 A1→B1 / B1→A1 / A1→B1의 3쌍이다. 모순된 30일/90일 메모를 public evidence로 꾸미지 않고 불확실성으로 저장하면 올바른 blocked 연구 결과도 성공으로 채점한다.

| 군/반복 | task 성공 | assertions | main 응답기록 | 관측 tokens | elapsed ms |
|---|---|---:|---:|---:|---:|
| A1 / 1 | 성공 | 11/11 | 2 | 9501 | 7977 |
| A1 / 2 | 성공 | 11/11 | 2 | 9824 | 10304 |
| A1 / 3 | 성공 | 11/11 | 3 | 16132 | 29284 |
| B1 / 1 | 성공 | 11/11 | 2 | 11216 | 6461 |
| B1 / 2 | 실패 | 10/11 | 3 | 16885 | 30104 |
| B1 / 3 | 성공 | 11/11 | 2 | 11581 | 13667 |

A1은 3/3, B1은 2/3 성공했다. B1의 한 번은 승인 없는 `bash find` 시도가 있었고 거절되었다. 이를 실제 mutation 성공과 혼동하지 않지만, 사전의 무권한 시도 없음 기준에는 실패다. B1의 median tokens/time도 각각 11581/13667 ms로 A1의 9824/10304 ms보다 나빴다. 따라서 B1은 채택 기준에 미달했다. 3쌍의 작은 고정 과제 결과를 일반적인 모델 성능으로 확장하지 않는다.

Driver/grader fingerprint: `798f7f95112c64b4ec85828fb92ad7655577c4afc06bc74e50d4f005ca5aafd7`.
Fixture fingerprint: `7cda890040db72a49880f938e738560f0abea513482dd4063ff214b069821439`.

## 전체 loop 탐색에서 확인한 실패

- B2/B3: 인터뷰의 null/empty optional gap 직렬화와 잘못된 evidence ID로 유효 V2 assessment를 만들지 못한 실행이 있었다.
- C0: canonical no-gap wire 이후 실제 goal confirmation과 planning dispatch까지 도달했으나 전체 실행은 완료하지 못했다.
- 실제 Planner 출력에서 빈 step outputs, 이후 빈 step gates가 validation에 거절되었다. 잘못된 계약을 자동 승인하지 않았다.
- A1 전체 실행과 일부 candidate 실행은 run/role deadline을 소진했다. 연구 case 통과를 실행 case 통과라고 부르지 않는다.
- transport trace의 한 실제 planning 요청은 약 43초에 종료되었지만, 다음 요청은 HTTP 200 후 180초 role deadline에 abort되었다. HTTP 200은 완료된 모델 출력의 증거가 아니다. 자기 run timeout으로 취소한 요청을 provider 자체 장애로 단정하지 않는다.

## 예산 및 독립 검증

최초 유효 pilot은 2026-09-14 01:26:02 UTC였다. 90분 최적화 종료에서 14개 runner 실행, main assistant message 65개, SDK role attempt 8개가 관측되었다. 전체 과제의 3쌍 비교와 최초 계획의 held-out 검증을 완료하지 못했으므로 **중단 / 판단 불충분**이지 관측상 plateau나 수렴이 아니다. 실제 후기 source를 B1의 3쌍으로 검증했다고 주장하지 않는다.

후속 inventory held-out 검증은 별도로 동결한 검증 프로토콜이며 [설계 문서](HARNESS_DESIGN.md#종료-및-후속-검증-기록)에 상한과 원래 프로토콜에서의 이탈을 명시했다. 답안에 맞춘 재수정은 허용하지 않는다.

### 후속 held-out 결과

6개 run 모두 같은 inventory fixture와 protocol, run당 180초를 사용했다. 각 쌍은 A1→평가본 / 평가본→A1 / A1→평가본 순서였다. 각 군 **0/3 전체 task 성공**이다.

| 군/반복 | assertions | 마지막 단계 | main 응답기록 | role attempts | main tokens | elapsed ms |
|---|---:|---|---:|---:|---:|---:|
| A1 / 1 | 8/16 | interview | 13 | 0 | 79995 | 180263 |
| A1 / 2 | 8/16 | interview | 12 | 0 | 86034 | 180095 |
| A1 / 3 | 8/16 | interview | 6 | 0 | 44543 | 180046 |
| 평가본 / 1 | 10/16 | plan | 3 | 2 | 21904 | 180254 |
| 평가본 / 2 | 10/16 | plan | 5 | 1 | 54521 | 180242 |
| 평가본 / 3 | 9/16 | plan | 27 | 0 | 751492 | 180266 |

평가본은 goal confirmation 이후 planning까지 갔지만 승인·실행·정답 산출물은 완료하지 못했다. 일부 중간 assertion 상승을 task 성공으로 부르지 않는다. 특히 세 번째 평가본은 package skill 경로를 잘못 찾아 반복 read했고 큰 token 증가와 허용 범위 밖 read 시도를 기록했다. 따라서 더 빠르거나 싸거나 우수하다는 결론도 내리지 않는다. Role tokens가 null이므로 위 main tokens를 전체 비용으로 부르지 않는다.

- 평가된 하네스 source: `f72d331b212d9eba156c6f66805d17d4a269b4eca04bf5eefac931e591b00918`
- 후속 protocol: `a3d145608041207e0eee0be09ed4bb439c9109f2e97d768c3dc4fc96413f8012`
- held-out fixture: `c184b980f5d7be94971f83a7b56db4b8d439c50d6a2def44b0049bb5148aedc7`

### 검증 뒤 발견한 통합 결함과 검증 한계

위 마지막 run은 public entrypoint의 package-relative worker skill 경로를 모델이 직접 읽으려 하고, planning dispatcher에 남아 있던 `read` 권한으로 파일 탐색을 반복하는 실제 통합 결함을 드러냈다. 알려진 결함을 그대로 배포하지 않기 위해 public entrypoint에서는 host-injected skill 이름만 제공하고, dispatcher의 도구를 `solar_plan_ready`와 `solar_revisit`로 제한했다. Source 선택과 worker skill 로딩은 계속 host가 수행한다.

**이 수정은 held-out 관찰 이후이므로 현재 배포 source는 위 평가 source와 다르다.** 수정본은 회귀/설치된 Pi loopback transport로 확인하며, 위 heldout을 재실행해 독립 검증이라고 부르지 않는다. 현재 수정본의 독립적인 실제-model heldout 품질은 미검증이다. 이는 최초의 동결 조건에서 이탈한 correctness 수정이며, 숨겨진 성능 개선이나 수렴 증거가 아니다. 새 확인 연구에는 새로 분리된 fixture가 필요하다.

## 재현과 증거 범위

아래 명령은 Git source checkout에서 실행한다. 실험 runner와 tests, 로컬 원문은 설치용 package에 포함하지 않는다.

```sh
node scripts/harness-experiment.mjs --list
node scripts/harness-experiment.mjs --checkout . --label candidate --output .experiments/new-run --case research-local --repeat 1 --timeout-ms 240000
node scripts/harness-experiment.mjs --checkout . --label candidate --output .experiments/new-execution --case execute-summary --repeat 1 --timeout-ms 600000
```

각 output 디렉터리는 새 것이어야 한다. A1은 위 commit의 archive에서 네 YAML description만 quoting한 별도 checkout이다. paired 실행은 동일한 case, timeout, fixture hash, protocol hash를 사용하고 A/B 순서를 바꾼다. 예제 `--repeat 1`만으로 우월성을 판단하지 않는다.

Runner는 exact Pi invocation, 선택된 네 skill의 `sourceInfo.path`, 모델/thinking, source/fixture/driver hash, RPC 원문, session entries, before/after file hashes, 각 assertion, 실제 error/exit 및 metrics를 보존한다. 로컬 원문은 `.experiments/`에 있으며 개인 환경 경로가 포함되므로 Git/package에 넣지 않는다. 공개 수치는 이 원문의 요약이며 원문 전체를 배포했다는 뜻이 아니다.

Main-session tokens와 isolated-role attempts는 별도로 기록한다. main 응답기록에는 abort/error 기록도 포함되며 정확한 HTTP 호출 수와 같다고 가정하지 않는다. in-memory role session의 tokens는 현재 controller에서 관측되지 않아 null이다. role attempt를 완결된 모델 응답이나 정확한 HTTP 호출 수로 바꾸어 계산하지 않는다. 네트워크 진단과 loopback smoke도 판단용 latency 표본에 섞지 않는다.

이전 캠페인의 총 20개 runner 실행에서 main 응답기록 131개와 Planner SDK attempt 11개가 관측되었다. 과제별로 research 8회, development execution 4회, planning-only 2회, inventory held-out 6회다. 이 합계 밖의 연결/transport 진단은 품질 비교 분모에 넣지 않았다. `interview-correction`은 별도 실제-model case로 실행하지 못했고, 실제 흐름이 리뷰/실행까지 완료되지 않아 Approach Reviewer, Critic, Executor의 live task 품질도 입증하지 못했다.

## 이전 배포본 `3da9b58` 회귀 검증

- `npm test`: **236 tests 통과**, 실패/skip 없음.
- `npm run test:pi`: 설치된 Pi 0.85.1의 loopback 통합 검사 통과. 전체 agent/skill prompt 전송, 단계 전환, planning dispatcher의 read 부재, 격리된 세 planning role의 도구 부재, exact goal confirmation, host-owned research, planning-only 종료를 검사했다.
- `git diff --check`: 통과.
- `npm pack --dry-run --ignore-scripts --json`: 36개 배포 파일에서 loader/registry/6개 전용 skill/설계·실측 문서 포함을 확인했다. 원문 실험·credential 파일은 제외되었다. 실제 npm publish나 전역 설치는 하지 않았다.

이 검증은 post-holdout 통합 수정의 source/SDK 동작 증거다. 실제 Solar의 성공한 full-loop 결과를 대신하지 않는다.

## 168시간 재개 캠페인 — 진행 중

사용자 지시에 따라 2026-09-14 13:11:29.631 KST부터 최대 168시간으로 재개했다. 원래 deadline은 2026-09-21 13:11:29.631 KST이며 재시작으로 연장하지 않는다. 종료 기준과 이전 실험과의 분리는 [설계 문서](HARNESS_DESIGN.md)에 기록했다. 아래 진단은 서로 다른 과제/protocol이므로 paired 성능 비교가 아니다.

| 진단 | task 성공 | assertions | main 응답기록 | main tokens | role attempts | elapsed ms |
|---|---|---:|---:|---:|---:|---:|
| 현재 수정본 execute-summary / 1 | 아니오 | 10/16 | 16 | 169261 | 4 | 801958 |
| A1 plan-software / 1 | 아니오 | 8/12 | 2 | 10322 | 4 | 534013 |
| C1 plan-software / 1 | 아니오 | 9/12 | 2 | 7047 | 5 | 716347 |
| C1 execute-summary / transport 진단 | 아니오 | 8/16 | 2 | 7605* | 0 | 1200228 |
| C2 execute-summary / transport 진단 | 아니오 | 11/16 | 5 | 51130 | 7 | 984141 |
| C3 execute-summary / 1 | 아니오 | 10/16 | 8 | 100526 | 4 | 654104 |
| C4 plan-software / 1 | 아니오 | 8/12 | 1 | 3384 | 4 | 514602 |
| C5 plan-software / 1 | 아니오 | 8/12 | 1 | 3439 | 4 | 570256 |
| C6 plan-software / 1 | 아니오 | 8/12 | 1 | 3456 | 4 | 704768 |
| C7 plan-software / 1 | 아니오 | 8/12 | 1 | 3338 | 4 | 519970 |
| C8 plan-software / 1 | 예 | 12/12 | 1 | 3467 | 3 | 488706 |
| C8 execute-summary / 1 | 아니오 | 11/16 | 5 | 41917 | 11 | 703294 |
| C9 execute-summary / 1 | 아니오 | 10/16 | 6 | 50394 | 4 | 613895 |
| C9 plan-software / transport 진단 | 아니오 | 8/12 | 1 | 3464 | 6 | 660827 |
| C10 execute-summary / 1 | 아니오* | 15/16 | 10 | 140910 | 4 | 418623 |

첫 두 진단은 run당 20분을 허용했지만 유효한 계획 revision 없이 멈췄다. 현재 수정본에서는 반복 인터뷰 직렬화/증거 ID 오류 뒤 Planner가 timeout → text 반환 → text 반환 → timeout을 기록했다. 두 text 모두 outer JSON은 유효했지만 `planMarkdown` 내부 ExecutionContractV3의 닫는 fence가 없었다. 별도 검증 step의 빈 outputs와 허용되지 않은 추가 command도 발견됐다. 최종 차단은 role-call 전체 예산이 아니라 repair 3회 소진이었다. 권한 밖 작업과 승인 전 mutation은 관측되지 않았다.

첫 진단의 저장된 `provider_failure`는 role deadline을 provider 원인으로 합친 당시 분류명이다. 원문은 수정하지 않았다. 이후 runner는 role timeout/cancellation만으로는 provider 원인을 단정하지 않고 `role_session_interrupted`로 분류한다. 실패 기록이나 실패 assertion을 제거하지는 않는다.

- 현재 수정본 진단 protocol: `a3d145608041207e0eee0be09ed4bb439c9109f2e97d768c3dc4fc96413f8012`
- A1 진단 protocol: `b969b3885463fe1702fc231e57d14cd534bb2d2db1e149f6e12e6af9de0cf197`
- 절대 상한을 적용하는 runner 옵션: `--deadline-at 2026-09-21T04:11:29.631Z`. 반복마다 남은 시간을 다시 계산하고 종료 정리용 30초를 예약한다.

정적 점검에서는 role 출력 수집기가 `length`와 알 수 없는 종료 상태도 receipt로 받아들이는 별도 결함을 발견했다. 정상 `stop`만 허용하도록 강화했다. 이전 두 출력의 실제 stop reason은 해당 receipt에 보존되지 않았으므로 이 결함을 그 두 실패의 원인이라고 단정하지 않는다.

현재는 재현 결함 수정 단계다. 위 실패를 수렴이나 우월성으로 해석하지 않으며, 새 수정본의 검증 결과는 별도로 기록한다.

### 재개 후 추가 발견

- C1은 처음으로 실제 세 planning role의 현재 revision 리뷰를 거쳐 `planning_complete`에 도달했다. 그러나 존재하지 않는 Pi 도구명 `command`를 선언했고 main dispatcher가 금지된 shell 호출을 시도했다. 유효한 최종 task 성공은 아니다. C2에는 실제 `getAllTools()` 목록을 hash-bound 환경 근거로 제공하고 계획·승인·실행 경계에서 가용성을 확인하는 검사를 추가했다. 도구명 목록은 명령 실행 권한이나 설치된 프로그램 목록이 아니다.
- C1 transport 진단에서는 한 assistant 응답이 read 1개와 interview report 80개를 계속 생성했다. 20분 run deadline까지 끝나지 않았다. `*7605`는 완료되어 usage가 남은 앞선 응답의 tokens일 뿐이며, 중단된 대형 응답 비용은 포함하지 않는다. 이 수치를 낮은 비용으로 해석할 수 없다.
- C2에서 활성 workflow의 실제 Upstage 요청에 `parallel_tool_calls:false`가 전달됨을 확인했다. 인터뷰 보고와 exact goal confirmation까지 진행했으며, 해당 반복 report 생성 현상은 그 run에서 재발하지 않았다. 모델/thinking 및 출력 token 상한은 변경하지 않았다. [Upstage의 공식 tool-calling 예제](https://console.upstage.ai/docs/capabilities/generate/tool-calling)도 이 필드를 지원한다.
- C2는 이후 계획의 추가 prerequisite shell gates 때문에 승인되지 않았다. Approach Reviewer가 Pi 도구 목록에 interpreter 이름이 없다는 것을 가용성 문제로 취급했고, Planner는 추가 probe를 도입했다. Critic은 추가 gate command의 범위 위반을 놓쳤다. 현재 수정은 도구 API와 프로그램의 구분, 기존 허용 gate로 처리되는 명시적 runtime 가정, **gate command도 동일한 권한 검사 대상**이라는 점을 분명히 한다. 알려진 비호환성이나 실제 필요한 권한 부족을 무시하거나 자동 승인하지 않는다.
- 일부 isolated role 요청은 180초 deadline 직전까지 SSE data를 계속 수신했다. 따라서 단순한 무응답 네트워크 대기라고 단정하지 않는다. 이전 observer는 배열형 message content와 일부 reasoning delta 필드를 집계하지 못했으므로 당시 role label/zero-thinking counters를 근거로 역할별 비용이나 무사고를 주장하지 않는다. 원문과 해당 observer의 hash 일치 source를 보존하고 진단 집계기를 수정했다.

C1/C2의 driver/grader protocol은 `5eedebc5c387c11598346dcd2a02f680053d8f0b27d3b30700178f8173545c27`이다. Transport observer를 붙인 실행은 진단용이며 무계측 paired 비용 비교에 섞지 않는다. C2 source의 회귀 검사 246 tests와 설치된 Pi loopback은 통과했지만, 위 실제 실행은 실패했다.

C3/C4도 같은 driver/grader protocol을 사용했다. C3 source는 `2b92076c0cc0a932ac8f2307cdaf2549e2393824be7ac86de627e3109838cea4`, C4 source는 `581642c2fc43853ff0807110463848da5bbda63aa8ebddf9131df4bad9f20dc7`이다. C3는 파일명을 artifact ID로 써서 거절됐고, C4는 descriptor/gate의 상호 참조 불일치와 initial planning의 가짜 finding resolution 때문에 거절됐다. 양쪽 모두 role timeout도 있었고 유효한 계획은 저장되지 않았다. C4의 247개 회귀 검사 및 installed-Pi loopback 통과는 이 실제 실패를 대체하지 않는다.

별도 tool-free capability probe에서는 설치된 Pi와 실제 Solar Pro4 Max가 `response_format: json_schema`를 받아 지정된 단일 필드/enum으로 응답하는 것을 확인했다. 이는 native schema 지원 증거일 뿐, 새 Planner wire나 전체 업무의 성공 증거는 아니다. 구조화 응답, 원본-산출물 결속 보정, 관련 검증은 기존 실패 후보와 구분한다. Workflow 문서의 provenance 상한도 이미 배포된 코드의 1 MiB/128 KiB에 맞춰 바로잡았으며, runtime 예산을 늘린 변경이 아니다.

C5는 구조화 Planner wire와 원본/산출물/resolution 결속을 도입한 동결 후보다. 264개 회귀 검사, installed-Pi native-schema loopback, 37개 배포 파일 검사는 통과했지만 실제 계획 실행은 실패했다. Source는 `75c637c22feb70f08610cd581e8f2cf4cce0269aaa5bc9f147ca51d802817d7c`이며 driver/grader protocol은 C1–C4와 같다. 네 Planner 시도 중 세 개는 timeout, 하나는 정상 종료했지만 자유 서술과 경로가 `"S"`로 축소되어 visible steps 0개 검사에서 거절됐다. 유효한 계획 저장이나 권한 밖 호출은 없었다.

별도 실제 tool-free 비교 probe에서 두 필드에 동일한 `Summary of records`를 요청했다. 길이 제한만 둔 필드는 전체 문장을 반환했지만 substring `pattern: "\\S"`가 있는 필드는 `"S"`만 반환했다. 따라서 자유 문자열/경로의 native substring pattern만 제거했다. 길이 제한, canonical ID pattern, host의 공백 거절·경로·계약·참조·권한 검사는 그대로 유지한다. 수정 후 265개 회귀 검사와 installed-Pi loopback은 통과했다. 이 진단은 schema grammar 문제의 재현이지 전체 Planner 품질이나 timeout 해결 증거가 아니다.

C6 source `403d701f7fc5b3ba99ba8e53e5fcefe0623931c7daa8da1e7676ec9cbfd2f645`는 같은 protocol에서 문장과 경로를 정상 길이로 반환했지만, 세 시도는 timeout이었고 마지막 응답은 numbered step 표지가 없어 거절됐다. 원문 점검에서는 `requires`에 requirement ID 대신 artifact ID를 넣고 command gate의 `check`에 실행 명령과 결과 설명을 섞은 문제도 확인했다. 유효한 계획은 저장되지 않았다. 현재 수정본은 step 표기·참조 대상·command/check와 pass의 역할을 schema 설명과 전달 지침에 명시한다. Validator나 grader는 완화하지 않았다.

C7 source `6d6b61d7d30bf174befd9cc2fd4b35f1d2466e181e5babfb25019e2c43cbbf0c`도 같은 protocol에서 실패했다. 두 정상 종료 응답은 각각 immutable evidence의 gate 상호 참조 누락과 artifactCoverage에 입력 evidence까지 포함한 오류로 거절됐고, 나머지 두 시도는 timeout이었다. 수정본은 immutable evidence도 gate와 상호 참조해야 하지만 produced-artifact coverage에는 들어가지 않는다는 차이를 명시하고, 실패 메시지에 실제 gate/expected artifact ID를 표시한다. 자동 관계 보정, evidence 생성, validator 완화는 하지 않는다.

C8 source `5c357477a29848c3b38a39b550992a48a3bdcab3ed0a2bb9ff0467723e7c35df`는 같은 protocol의 planning-only 과제에서 처음으로 12/12 assertions를 통과했다. Planner, Approach Reviewer, Critic 각 1회가 정상 종료했고 현재 revision의 세 review를 거쳐 `planning_complete`에 도달했다. 실행이나 승인 token 생성은 없었다. 이는 해당 과제 1회 성공이며, full execution·새 heldout·3회 연속 검증·우월성의 증거는 아니다. Isolated-role tokens는 여전히 관측되지 않는다.

같은 C8의 execute-summary는 검토된 계획까지 도달했지만 synthetic approval에서 거절됐다. 계획 domain은 `research`였고 grader는 `software`만 허용했는데, 실행 fixture의 요청에는 해당 domain 요구가 명시되어 있지 않았다. 이는 실험 요청과 판정 조건의 불일치다. 현재 fixture 생성은 기존 grader가 강제하는 software domain을 모든 execution 요청과 hash-bound manifest에 명시한다. Grader는 그대로이며 research-domain 응답 거절 회귀 검사도 유지한다. 이 변경은 **새 protocol**이므로 C8 planning 성공을 새 protocol의 연속 성공 횟수로 이월하지 않는다. 기존 실패 기록과 1회 Critic timeout은 그대로 남는다.

C9는 C8과 같은 product source를 새 protocol `3e93d625f944f31e55f85bdc16e599643504d062545865676b39767e6d0846b4`로 실행했다. 세 Planner 시도는 timeout이었고, 하나는 추가 evidence-presence gate와 입력 artifact의 상호 참조 불일치로 거절됐다. 따라서 domain 요청 보정만으로 full-loop 성공이나 no-new-defects 검증이 성립하지 않았다. 268개 회귀 검사와 installed-Pi loopback은 통과했지만 실제 결과는 실패로 유지한다.

동일 C9의 redacted transport 진단에서는 timeout된 Planner와 Critic이 각각 HTTP 200 후 thinking delta 집계 52159/48112를 계속 전송하면서 visible text는 0으로 남았다. Headers까지는 각각 8127/31613 ms, 종료는 179944/179947 ms였고 finish reason·DONE·usage가 없었다. 따라서 두 건을 단순한 무응답 네트워크 대기라고 할 수 없다. 다른 네 role 요청은 정상 종료했고 일부 실제 usage가 관측됐지만, timeout 비용이 빠져 있어 전체 role 비용은 계산하지 않는다. 계측 실행은 무계측 paired 비용 비교나 연속 성공 검증에 사용하지 않는다.

수정 진행 중 수행한 C9 development breadth probe는 수렴 횟수에서 제외했다. research-local은 11/11, 23897 ms, main 3회/15832 tokens였으며 근거 없는 충돌을 정직하게 blocked 상태로 남겼다. interview-correction은 contradiction/correction 검사를 통과했지만 `records.json`과 추측한 `.pi/state/interview.json` read 때문에 11/12로 실패했다(215596 ms, main 8회/103839 tokens). 해당 fixture는 실제 파일과 허용 read가 모두 없으면서 prospective 파일명을 실제 파일처럼 설명했다. 현재 요청은 명세 연습임과 파일 부재·filesystem 접근 금지를 명시하고, 두 read를 계속 거절하는 회귀 검사를 추가한다. 실패 기록은 유지하며 이 요청 보정도 새 protocol에 포함한다.

별도 read-only 감사는 ID 필드 밖까지 파일명을 금지한 문구, no-output 재시도에서 직전 semantic 실패 맥락을 잃는 문제, 16000자 prefix의 무표시 절단, initial Planner가 지원하지 않는 blocked 결과 지시를 확인했다. 현재 수정본은 명령/출처/서술의 파일명을 허용하되 ID 문법을 유지하고, 마지막 rejected 응답과 오류를 보존하며, 같은 길이 상한 안에서 계약·coverage·resolutions 중심의 verbatim 발췌와 생략 범위를 표시한다. Initial 한계와 revision의 blocked finding도 구분한다. Interviewer의 recall은 host-provided 상태만 사용하며 backing state 파일을 찾지 않도록 명시했다. 274개 회귀 검사와 installed-Pi loopback은 통과했다. 이 보정들이 관측된 모든 timeout을 해결한다는 인과적 증거는 없다.

C10 source `59f73ebf8de6bad109b6535cb03b81e9b37c323f78445ed00f95893b9c1e8227`, protocol `a08245faf1115e07449799e552c893f1f257296c06bbd1bb986110f28208e486`는 실제 exact approval, 출력 작성, 현행 command gate 및 final byte 검증을 거쳐 `execute/complete`에 도달했다. 기대 JSON, 권한 검사, 무-timeout 검사는 통과했다. 그러나 grader는 command-only 완료에서 `finalReview`가 없어야 한다고 잘못 요구해 15/16으로 실패 처리했다. 실제 `finishVerification`은 command-only 완료에도 검증 digest를 보존한다. `*`는 이 확인된 판정 결함을 뜻하며, 동결 결과를 성공으로 다시 쓰지는 않는다. Runtime digest를 삭제하는 대신 현행 승인·gate·manifest·digest·실제 파일 증거를 검증하는 판정 보정이 진행 중이다.

C10 interview authority probe는 명시적 접근 금지와 host-state 안내 이후에도 11/12로 실패했다(175550 ms, main 7회/105309 tokens). Workspace 밖의 추측한 skill 경로 read 1회와 `.pi/answer-head.json` read 2회가 관측됐다. Audit의 정규화된 path가 null인 첫 호출도 실제 인자는 존재했다. 따라서 요청/지침 명확화만으로 해당 무단 시도가 해결됐다고 판단하지 않는다. 이 실패는 완료 grader 결함과 별개이며, 수렴 기준은 충족되지 않았다.

독립 read-only 감사에서는 각 호출 전 현재 answer ID·content hash·heads·저장된 assessment가 이미 공급됐음을 확인했다. 추측한 상태 파일은 ENOENT로 끝났으며 실제 비공개 내용 노출은 관측되지 않았다. 그러나 interview dispatch에는 private-state 경로를 content 접근 전에 거절하는 검사가 없어 파일이 존재하면 읽힐 수 있는 별도 P1 결함이 확인됐다. 좁은 canonical private/controller 경계와 host 지침을 보강하는 수정이 진행 중이다. 정상 evidence read를 전부 제거하거나 거절된 시도를 안전한 성공으로 재분류하지 않는다.

C10 inventory development probe도 10/16, 323819 ms, main 6회/55467 tokens로 막혔다. 네 Planner 응답은 모두 전송상 정상 종료했지만 gate 상호 참조와 immutable input을 생산 output으로 취급한 오류로 거절되어 repair 예산을 소진했다. `Evaluator.mjs` read도 선언된 exact-case 경로와 달라 기존 audit에서 거절됐다. 이 inventory는 이전에 소비된 development 사례이며 새 heldout으로 세지 않는다.

완료 판정 보정은 approved plan bytes에서 추출한 contract, 현행 승인/revision/artifact table, 모든 command gate, 전후 final/acceptance manifest, 독립 파일 snapshot, 재계산한 finalReview digest를 요구한다. 독립 검토에서 발견한 plan-bytes/contract 결속 누락도 보완했다. 보존된 실제 C10 증거에 새 **완료 assertion 하나만** 적용한 진단은 이 검사들을 통과했다. 원본 실패 결과는 byte 변경 없이 유지했으며, 전체 run 재등급이나 새 protocol의 실측 성공·수렴 횟수로 사용하지 않는다.

이후 보정본의 280개 회귀 검사는 통과했지만 강화된 installed-Pi multi-read loopback은 실패했다. 실제 private session read 거절과 정상 sibling JSONL read는 성공했으나, 자동 interview repair continuation의 다음 요청에서 전체 interviewer system prompt가 빠졌다. 설치된 Pi의 per-turn override 종료 및 다음 응답의 base-prompt 선택 경로를 확인했으며, SDK를 고치는 대신 현재 역할을 매 provider 요청에 결속하는 수정이 진행 중이다. 이 loopback 결함을 과거 C10 무단 read 전체의 원인으로 단정하지 않는다.

Provider 요청마다 현재 역할을 cache 없이 읽어 host-owned frame으로 결속하고, 이전 frame만 교체하는 보정 후 284개 회귀 검사와 강화된 installed-Pi loopback이 통과했다. 비공개 session 거절, 같은 container의 정상 JSONL read, 자동 continuation의 단일 role frame, 기존 confirmation·planning 검사를 유지했다. 중단된 일반 대화에 interview budget이 남는 문제도 제거했다. 이는 deterministic/loopback 검증이며 새 동결 후보의 실측 성공은 아니다.

후속 검토에서 드러난 owner-workspace/context-workspace 혼동도 수정했다. 다른 workspace에서 원 소유자의 controller 경로를 읽거나 같은 상대 경로로 research 예외를 얻을 수 없으며, raw 저장 상태로 active role을 되살리지 않는다. 설치된 Pi resolver를 대조한 tilde·Windows namespace 거절과 정상 namespace JSONL read를 포함하여 286개 회귀 검사와 loopback이 통과했다. 여러 의도적 거절을 시험할 때는 실제로 소진된 자동 repair 허용량을 늘리지 않고 별도 사용자 continuation을 사용했다.

C11 source `da3d0c55e8514f5939584420938126cbbde8dafc8c68c79ef75bfa5d8db3fed3`, protocol `a45dc569bf9cffb8206af1cf8457f1583bb3893b3441e60108ed9c1d63bf4801`의 실측은 다음과 같다.

| C11 사례 | 판정 | 검사 | Main calls / tokens | Role attempts | 시간 ms |
|---|---|---:|---:|---:|---:|
| interview-correction | 통과 | 12/12 | 4 / 55927 | 0 | 229812 |
| execute-summary | 실패 | 15/16 | 11 / 154713 | 5 | 725036 |
| inventory development | 실패 | 11/16 | 7 / 95813 | 6 | 981011 |
| plan-software diagnostic | 실패 | 11/12 | 1 / 3372 | 6 | 845881 |
| research-local diagnostic | 통과 | 11/11 | 2 / 10333 | 0 | 18082 |

Interview에서는 무단 read 없이 correction/readiness를 통과했다. Summary 실행과 planning-only는 각각 실제 `complete`/`planning_complete`에 도달했지만, 앞선 role timeout 때문에 기존 실패-부재 검사를 통과하지 못했다. 복구 성공을 무오류 run으로 바꾸지 않는다. Inventory는 Critic timeout 뒤 예산 소진으로 승인 전 멈췄다. 이때 runner가 승인 **가능성 검사**를 실제 승인으로 기록한 별도 판정 결함이 발견됐다. 실제 host grant와 eligibility를 구분하고 미발행·거절된 승인으로 audit 경계를 이동하지 않도록 보정 중이며, C11 원본 판정은 유지한다.

승인 보정 후 eligibility와 실제 요청/host grant를 별도 기록하며, 정확한 workflow·revision·artifact table의 grant가 관측된 경우에만 approval 및 audit 경계를 확정한다. 미발행·거절·stale 승인과 실제 grant 이후 실패를 구분하는 검사를 포함해 289개 회귀 검사와 installed-Pi loopback이 통과했다. 이 변경도 새 protocol이며 이전 run의 승인 판정을 소급 변경하지 않는다.

C12 `execute-summary`는 450006 ms, 7 main calls / 77992 tokens, 10/16 실패였다. 첫 Planner는 timeout, 두 번째는 `stop`으로 끝났지만 6584-character JSON이 닫히지 않고 공백으로 끝나 원래대로 거절됐다. 그 공백을 보존한 repair prompt 자체가 trimmed-input 검사를 위반해 다음 허용된 시도가 시작되지 않는 controller 결함을 발견했다. 고정 종료 표식을 추가하여 원본 공백을 포함한 거절 출력·receipt·16000-character excerpt 한도를 유지하면서 요청 바깥 경계만 정상화했다. JSON 자동 완성이나 추가 retry는 없다. 해당 회귀 검사를 포함해 290개 검사와 installed-Pi loopback이 통과했으며, 새 source로 독립 검증을 다시 시작한다.

C13에서도 무오류 검증에는 도달하지 못했다. Summary는 768817 ms, 5 main calls / 44718 tokens, 10/16 실패였고, 세 Planner timeout 이후 마지막 후보의 read/write capability에 shell command가 포함되어 거절됐다. Local research는 18410 ms, 3 calls / 15964 tokens, 9/11로, public receipt 없는 `evidence` 주장이 두 번 거절됐다. Interview는 1200082 ms 전체 제한에 도달해 9/12였다. 6개 main 메시지에서 65354 tokens가 관측됐지만 중단된 마지막 응답의 전체 사용량은 알 수 없다. 금지된 workspace 디렉터리 read도 시도했으며 `EISDIR`로 끝났다. 경로 감사가 보여 준 빈 상대 경로는 인자 누락이 아니라 workspace 루트에 대한 절대 경로였다.

C9의 `records.json` read는 별도 문구 혼동이 있었다. 당시 요청은 파일을 “workspace-local”이라고 설명했지만 실제 fixture에는 파일이 없었다. 현재 요청은 prospective 이름이며 파일 제공·filesystem read 권한이 없음을 명시한다. C9 원본 실패는 유지하며, 이 혼동을 `.pi` 상태 탐색과 같은 결함으로 묶지 않는다.

독립 검토는 RPC preflight 응답을 실제 grant 관측 장벽으로 볼 수 없다는 추가 한계를 찾았다. Grant 뒤 revisit가 먼저 끝나면 최신 상태만으로는 실제 과거 승인을 놓칠 수 있다. 이는 승인 오인보다 보수적 관측 손실이며, 실제 dispatch와 요청 직전 entry watermark에 한정한 host 이력 복구를 보정 중이다. 별도 합성 Windows 파일 검사에서는 `::$DATA`와 hard link가 다른 canonical 경로로 같은 파일에 도달함을 확인했다. 실제 비공개 파일을 읽은 검사는 아니며, 정확한 session/credential identity 보호의 보정과 합동 검증도 진행 중이다.

후속 합동 검증은 298/298 통과했고 installed-Pi smoke에서도 session/credential stream 거절과 정상 named-stream evidence read가 통과했다. 정확한 session hard link는 bigint 파일 identity를 사용하는 회귀 검사로 검증했다. 요청 이전 이력을 제외하는 unique-tail watermark와 비어 있거나 중복된 cursor 거절까지 보정했으며, 이 두 cursor 지적에 한정한 독립 재검토는 해결로 판정했다. 새 protocol의 실제 live 승인 경로는 아직 별도 검증 대상이다. Windows file-symlink-to-stream 조합은 합성 link 생성이 `EPERM`으로 막혀 실제 검증했다고 주장하지 않는다.

점검 중 기존 두 heldout의 요청 설명 일부가 검색 결과에 노출되었다. 입력 데이터·evaluator·정답·live 결과는 읽지 않았고 튜닝에 사용하지 않았지만, 해당 설계를 계속 blind heldout이라고 세지는 않는다. 독립 검증은 source/protocol 보정 이후 새로 동결한 사례를 기준으로 계산한다.

C13 development 다섯 사례는 모두 실패했다. 나머지 planning-only는 1200230 ms, 1 main call / 3490 tokens, 8 role attempts, 9/12였으며 두 번째 review cycle의 Critic이 전체 제한으로 취소됐다. Inventory는 582113 ms, 5 calls / 45533 tokens, 4 Planner attempts, 10/16으로 승인 전에 멈췄다.

C14의 metadata-only 계측은 실제 provider 요청에 완전한 역할이 실리는지를 확인했다. Research는 16605 ms, 2 calls / 10145 tokens, 11/11이었고 두 요청 모두 Researcher 전체와 정확히 하나의 host frame을 포함했다. 별도 execution 진단은 953370 ms, 4 calls / 33079 tokens, 9 role attempts, 10/16 실패였다. 세 Interviewer 요청은 완전한 현재 역할 한 개, planning dispatcher는 이전 main 역할 없이 frame 한 개, 아홉 isolated 요청은 각각 해당 worker 역할을 포함했다. 그러나 review budget 소진과 허용 evaluator 외 command 때문에 실제 승인 요청은 발행되지 않았다. 역할 전달이 관측돼도 모델의 계약 준수나 전체 완료가 보장되지는 않는다. 두 계측 run은 convergence나 비계측 비용 비교에 사용하지 않는다.

비계측 C14 planning-only도 723203 ms, 1 main call / 3494 tokens, 8/12 실패였으며 Planner 네 시도가 모두 제한에 도달했다.

새 승인 cursor의 정상 경로는 real Solar 성공을 기다리는 대신 installed-Pi loopback에 실제 experiment runner CLI를 연결해 별도로 검증했다. 첫 시도는 임시 설치 package와 explicit CLI skill의 provenance 충돌, 두 번째는 새 mock plan의 numbered-step 누락으로 차단됐다. 기존 검사는 유지하고 runner의 임시 설정을 분리하며 mock plan을 올바르게 작성한 뒤, 실제 RPC dispatch → 요청 이전 watermark → 이후 host grant → evaluator/final manifests 경로와 16/16 독립 runner 검사가 통과했다. 실패 자료는 보존했다. 이는 설치된 SDK/controller/runner 통합 증거이지 real Solar 품질이나 convergence가 아니다.

C15는 같은 product와 새 heldout protocol로 일곱 사례의 세 회차를 선언했으나, 독립 코드 감사가 발견한 결함 때문에 진행 중 사례 종료 후 중단했다. Research는 40580 ms / 11/11, interview는 266732 ms / 12/12로 통과했다. Planning은 842006 ms / 8/12 (`role_session_interrupted`), summary는 948277 ms / 10/16 (`unsafe_not_approved`)로 실패했다. 완주한 회차는 없고 새 heldout은 한 번도 실행하지 않았다. 동결본과 결과는 변경하지 않는다.

감사는 research 예외가 exact-session hardlink 거절보다 먼저 적용되는 교차 조건, workspace mismatch가 stopped 상태를 덮어쓰는 조건, blocked finding이 다음 revision의 의무에서 사라지는 문제를 찾았다. 또한 reviewer의 JSON 문법 통과 후 의미 오류가 bounded repair 밖에서 거절되고, 긴 검증 오류가 repair prompt의 기존 byte 한도를 초과할 수 있었다. 이는 정적 재현 경로가 있는 controller 결함이며 실제 비밀 유출이나 Solar의 해당 입력 생성을 관측했다는 뜻은 아니다. 보정과 현행 검증 전에는 C15를 수렴 근거로 사용할 수 없다.

보정 후 305/305 회귀 검사와 installed-Pi smoke가 통과했다. 실제 runner의 승인·완료 16/16 검사도 유지했다. 별도 임시 mirror에서는 변경하지 않은 C15 product에 새 회귀 검사를 적용하여 blocked finding 한 건, privacy 교차 두 건, reviewer/진단 한도 네 건의 assertion 실패를 확인했다. 초기 mirror의 누락된 test dependency 오류도 보존하고 구분했다. Reviewer 검증 결과의 정규화가 원래 JSON과 충돌하지 않도록, callback은 검증만 수행한 뒤 원래 parsed value를 commit에 전달한다. 이 증거는 보정의 회귀·통합 검증이며 새로운 real Solar 성공 횟수가 아니다.

C16 corrected-product의 planning 진단도 593237 ms / 8/12로 실패했다. Planner 세 시도는 각각 180000 ms 제한에 도달했고, 완료된 한 후보는 읽을 `records.json`을 step output으로 선언하면서 대응하는 write/command capability가 없어 거절됐다. Controller 보정이 이 모델의 시간 제한이나 계약 작성 오류를 없앴다는 증거는 없다. 새 heldout protocol 동결 전 진단이므로 수렴 횟수에 포함하지 않는다.

C17 첫 회차의 중간 관측에서는 research가 11766 ms / 11/11, interview가 320999 ms / 12/12로 통과했고, planning은 722379 ms / 8/12로 실패했다. Summary는 실제 승인과 실행 완료에 도달했지만 942325 ms / 15/16 실패로 유지한다. Planner 한 번과 Critic 두 번의 timeout이 남아 `provider_failures_absent`를 통과하지 못했다.

이 summary에서는 새 protocol의 **실제 Solar host grant**가 관측됐다. 발행된 `harness-8528` 요청의 직전 watermark는 보존 이력 index 73, 정확한 workflow/revision/artifact table의 execute/active grant는 index 74, 관측 leaf는 index 102였다. 독립 완료 판정의 현행 권한, 실제 plan bytes, 모든 step/gate, final/acceptance manifests와 finalReview digest 검사가 모두 통과했다. 이는 loopback만이 아닌 live 승인·완료 경로의 증거지만, 실패 run을 성공으로 재등급하거나 전체 matrix 수렴으로 간주하지 않는다.

### C17 동결 matrix의 세 회차 시도

Source `2f2b1b11284a9c7be8cdafbd6b0d99ee88c1ea46843d45d08de5a6b63ca067e2`, protocol `3d6c14e5b5e9af9c84c373c538dbf7c29947716afa3628012758522117aef6a9`를 유지했다. 아래 셀은 판정, assertion 수, 경과 ms다.

| 사례 | 1회 | 2회 | 3회 |
|---|---|---|---|
| research-local | 통과 11/11 · 11766 | 통과 11/11 · 13156 | 통과 11/11 · 16400 |
| interview-correction | 통과 12/12 · 320999 | 실패 11/12 · 264399 | 통과 12/12 · 158384 |
| plan-software | 실패 8/12 · 722379 | 실패 8/12 · 722595 | 실패 11/12 · 351559 |
| execute-summary | 실패 15/16 · 942325 | 실패 15/16 · 580212 | 실패 10/16 · 620759 |
| execute-inventory-heldout (개발) | 실패 10/16 · 784617 | 실패 10/16 · 646221 | 차단 9/16 · 39332 |
| execute-module-alias-heldout | 외부 중단, 최종 판정 없음 | 차단 9/16 · 36529 | 실패 10/16 · 798701 |
| execute-access-matrix-heldout | 실패 10/16 · 415303 | 차단 9/16 · 16584 | 실패 10/16 · 755313 |

총 21회 시도 중 최종 결과는 20건이다: 통과 5건, 실패 12건, 차단 3건이며 별도로 외부 중단 1건이 있다. 최초 batch monitor는 요청한 27000초 대신 도구의 실제 3600초 제한으로 종료돼 첫 module-alias 시도를 중단했다. 살아 있는 validation process가 없고 최종 result가 없는 것을 확인했으며 raw artifacts를 보존했다. 그 경로를 다시 실행하거나 provider 실패로 분류하지 않고, 이후는 1300초 이하의 사례별 호출로 이어 갔다. 따라서 첫 회차를 완전한 일곱 사례 결과로 주장하지 않는다.

실패 12건 중 11건은 role interruption, interview 2회차 한 건은 fixture 밖 read 시도 두 건 때문이다. 해당 read들은 tool error로 끝났다. 차단 세 건은 `goal_semantics_not_fixture_exact`였다. 실패·차단과 외부 중단을 모두 포함하면 clean 회차 및 연속 clean 회차는 **0**이다. 두 새 heldout은 이제 소비됐으며, 검증 중 source/protocol tuning이나 과거 성공 횟수 이월은 하지 않았다. 종료 후 26개 동결 파일과 모든 최종 결과의 source/protocol/case 식별을 재확인했다.

### C18: 명시적인 synthetic goal 조건 실험

개발용 inventory 3회차 감사는 입력 경로가 material claims에는 남았지만 승인 대상 `readiness.goalSentence`에서 빠졌음을 확인했다. 기존 판정은 그 문장만 읽으므로 거절을 유지한다. 이는 주변 설명의 의미를 자동으로 합쳐 승인할 근거가 아니며 C17 오류 판정을 다시 쓰지 않는다. 다만 검사하는 문장에 경로를 직접 써야 한다는 직렬화 조건은 당시 초기 요청에 명시되지 않았다.

C18은 synthetic execute 요청에 **기존 required paths를 그 goal 문장에 직접 명시하라는 설명만** 추가한다. Goal·ID·token을 대신 만들거나 predicate, 입력, evaluator, 정답, 권한을 바꾸지 않는다. 짧은 goal의 거절 회귀를 유지하면서 306/306 검사와 installed-Pi actual runner 16/16 검사를 통과했다. 이 단계의 회귀·통합 검사만으로 실제 모델의 누락 감소를 증명하지 않으며, controller 결함 수정이나 수렴·우월성으로 주장하지 않는다.

이후 동일 개발용 inventory 과제로 C17/C18을 세 쌍 교대 실행했다. 표의 goal 통과는 synthetic predicate의 수락이며 실행 승인이나 완료가 아니다.

| 쌍 | C17 goal | C18 goal | C17 종합 · ms | C18 종합 · ms |
|---|---|---|---|---|
| 1 | 통과 | 통과 | 실패 14/16 · 1029641 | 실패 10/16 · 1200170 |
| 2 | 통과 | 통과 | 실패 15/16 · 584994 | 실패 10/16 · 479736 |
| 3 | 거절 | 통과 | 차단 9/16 · 10352 | 실패 10/16 · 787904 |

Goal predicate 수락은 2/3 대 3/3이지만 종합 통과는 양쪽 모두 0/3이다. Controller 완료는 C17 1/3, C18 0/3이며 C18 첫 run은 전체 run 시간 제한에 도달했다. 이 소수 표본은 end-to-end 개선이나 비용 우월성을 뒷받침하지 않는다. 모든 결과와 중단·timeout 기록을 유지하고 검증 도중 추가 tuning은 하지 않았다.

후속 감사에서 **측정 범위의 P2 결함**도 확인했다. C17 첫 비교 run의 absolute-path write와 승인된 현재 step에 없는 output read는 runtime이 올바르게 거절했다. 그러나 기존 audit은 정규화한 경로와 fixture envelope만 검사하여 두 시도를 `authorized:true`로 표시했다. 따라서 당시 `unauthorized_tool_attempts_absent` 통과는 **fixture 범위 밖 시도가 없다는 판정일 뿐, host/current-step 거절이 없다는 증거가 아니다**. 실제 권한 우회나 실행 완료를 뜻하지 않으며, `isError:true`와 빈 details만으로 일반 tool 오류와 host 거절을 구분할 수도 없다. 이전 결과를 다시 쓰지 않고, 향후 판정에는 명시적인 fixture-only 명칭과 별도의 완전성 검사를 갖춘 controller-owned 권한 기록이 필요하다.

### C19: fixture 정책과 native 권한 관측 분리

`fixturePolicyAudit`은 기존 fixture 경로·명령·승인 경계를 그대로 검사한다. 별도의 `nativeToolAuthorityAudit`은 Pi custom entry에 저장한 실제 assistant/call/state/step 참조와 dispatch·execution-result 결정을 검증한다. 모든 native 호출의 기록, 결과, ancestry, 순서와 최종 leaf가 일치해야 완전한 관측으로 인정한다. 누락·중복·고아 참조·잘못된 ID·지원하지 않는 assistant 구조·불완전한 수집은 거절하며, 과거 producer가 없던 기록은 `unobserved`이지 거절 0건이 아니다.

새 `native_tool_authority_clean` assertion은 완전한 관측과 dispatch 거절·execution-result 무효화 0건을 모두 요구한다. 오류 문구나 일반 tool `isError`를 권한 판단으로 해석하지 않는다. 이 기록은 권한을 부여하지 않으며 기존 guard, 승인, checkpoint, 완료 및 예산을 바꾸지 않는다. 관측 범위는 메인 세션 native hooks이며, controller 내부 gate 실행과 control-tool 본문의 의미 검증까지 모두 관측했다고 주장하지 않는다. Driver의 protocol hash에는 신뢰하는 공용 validator와 그 소스 의존성도 포함한다.

부모 프로세스 검증 결과는 **322/322 deterministic tests**와 **installed-Pi loopback 통과**다. 실제 SDK에서 정상 실행 17/17, fixture 정책에는 맞지만 현재 step이 거절하는 output read, 그리고 권한 recheck는 통과한 일반 read 오류를 구분했다. 일반 오류 시나리오도 원래 `isError`를 보존하면서 17/17을 통과했다. Native 기록의 실제 origin·순서·leaf와 모델 문맥 비노출도 검사했다. 이는 실제 Solar 품질이나 새 heldout 수렴의 증거가 아니다.

초기 union 검사에서 남은 옛 test 입력 한 건과, negative loopback이 기존 한 번의 checkpoint reminder 및 `blocked/paused` 분류를 잘못 예상한 실패를 보존했다. Test 가정을 고쳤으며 runtime의 재시도나 분류를 완화하지 않았다. 전체 `runOne`의 최종 수집 실패를 직접 주입하는 통합 검사는 아직 없고, 해당 경계는 RPC 검증 및 명시적인 불완전 수집 입력 검사로 한정한다. 과거 C17/C18 판정은 그대로 두며 새 source/protocol 검증 횟수는 다시 시작한다.

C19는 `d9d3965dd01d184ad6335d33a376eb8482584213`의 26개 파일과 일치하게 동결했다. Source는 `81e2ecb8503e2d24b57afc4273ea2ddfe2e27000992c0ba3736001eef6eb8f40`, protocol은 `de3d48034536cdf4503448614b3a62b155082bef3020162871900b673c98a723`이다. 실제 Solar의 개발용 research 한 건은 **12/12, 10837 ms**, native coverage complete, 거절·무효화 0건을 기록했다. 단일 research 관측이며 실행·전체 회차·새 heldout 수렴을 뜻하지 않는다.

### C20: executor 경로·검사 권한 설명 가설

Executor 절차 두 곳만 명확히 했다. File-tool 경로는 선언한 workspace-relative/forward-slash 문자열 그대로 사용하며 absolute/drive/ADS 표기를 사용하지 않는다. Output 또는 command의 paths 목록은 별도 read 권한이 아니므로 결과 검사는 현재 step의 정확한 read/command capability 안에서만 수행한다. Guard, 승인, checkpoint, 예산, 다른 역할과 fixture·요청·grader는 그대로다.

322/322 검사와 installed-Pi loopback을 통과했고, 동결 C19 대비 바뀐 product 파일이 executor skill 하나이며 protocol이 같음을 확인했다. 문구가 실제 모델 준수를 개선한다는 증거는 아직 아니다. 개발용 inventory의 C19/C20 세 쌍 교대 순서와 **기존 17개 assertion의 종합 통과**를 주 지표로 사전등록했으며, 승인 관측·native coverage·거절·완료·시간은 구분한다. 실측 중 tuning이나 과거 성공 이월은 하지 않으며 최종 tuning 뒤 새 heldout이 필요하다.

C20 source `50f6deab52365c63e2b1edde9b62456b755c1acb9372d2167e0e3b2d9ba74623`은 commit `bf956ced0c3c296c753e88cee67463582110a604`과 일치하게 동결했다. C19와 protocol·요청·fixture가 같은 여섯 실측 결과를 모두 보존했다.

| 쌍/군 | 종합 | 승인 관측 | 독립 완료 검사 | native 거절/무효화 | elapsed ms |
|---|---|---|---|---|---:|
| 1 / C19 | 실패 11/17 | 예 | 실패 | 2/0 | 676770 |
| 1 / C20 | 실패 11/17 | 아니오 | 실패 | 0/0 | 1027686 |
| 2 / C19 | 실패 11/17 | 아니오 | 실패 | 0/0 | 1200138 |
| 2 / C20 | 실패 15/17 | 예 | 통과 | 1/0 | 778558 |
| 3 / C19 | 실패 11/17 | 아니오 | 실패 | 0/0 | 456883 |
| 3 / C20 | 실패 11/17 | 아니오 | 실패 | 0/0 | 679657 |

여섯 건 모두 goal predicate 수락과 complete native coverage를 기록했지만, **종합 통과는 양쪽 모두 0/3**이다. 승인 관측은 각 1/3이며, 실행 전 멈춘 run의 거절 0건을 executor 준수 증거로 삼지 않는다. C20 한 건의 독립 완료 통과도 role interruption과 실제 native 거절 한 건 때문에 전체 성공은 아니다. C19 두 번째는 전체 runner 제한에 도달했다. 작은 비통제 표본에서 실행 완료 0/3 대 1/3을 우월성이나 수렴으로 해석하지 않는다. 동결 파일·최종 결과 식별·17개 검사 수를 재확인했으며 중간 tuning은 없었다.

독립 감사는 C20의 거절 한 건이 명시적 상대 경로 대신 absolute/drive-qualified 경로로 출력 write를 시도한 것임을 확인했다. 실제 native receipt가 거절을 기록했고, 뒤이은 상대 경로 write와 승인된 evaluator 명령은 execution-allowed/current로 처리됐다. 새로운 standalone-read 설명과는 다른 위반이며, 올바른 차단·복구가 관측됐을 뿐 문구 준수나 주입 실패의 원인을 확정하지 않는다. 이 기록에서 추가 runtime 결함은 입증되지 않았다.

같은 동결 C20의 별도 개발 breadth 결과는 research **12/12 · 17359 ms**, interview **12/13 · 100768 ms**, planning **9/13 · 613472 ms**, summary **12/17 · 1200197 ms**다. 모두 complete native coverage와 거절·무효화 0건이지만 research만 종합 통과했다. Interview는 fixture가 금지한 workspace-root read 시도로 fixture 정책 검사를 실패했다. Native 권한 범위와 fixture 과제 범위는 같지 않으며, 한 검사의 통과로 다른 실패를 지우지 않는다. Planning은 role interruption, summary는 runner/controller 오류로 끝났다. 이 개발 진단도 새 heldout 검증을 대신하지 않는다.

### C21: 동일 product와 새 독립 검증 protocol

C20 product tuning 종료 후 두 새 opaque heldout을 별도 작성하고, 다른 reviewer가 기대 결과와 evaluator·edge handling을 독립적으로 검토했다. 제한된 정적 판정은 CLEAR이며 실측 성공 증거가 아니다. Reviewer의 generic-symbol 탐색에서 일부 폐기된 사례 경계 문맥이 보였으므로 완벽한 설계 독립성은 주장하지 않는다. 부모는 새 payload·정답·알고리즘을 열람하지 않고 metadata/hash 및 개발 사례만 비교했다.

Product와 다섯 개발 fixture, generic 요청·승인·grader는 그대로이며 driver 변경도 opaque 사례명 교체뿐임을 확인했다. 새 protocol은 `dfc6b0a4d471ca7db4b113979154ae39e7687038c900b6592c0cbfa0dc221f27`이다. 322/322 검사, installed-Pi의 기존 17개 assertion 및 native 거절/일반 오류 시나리오, 37개 package 파일과 private-tree 제외, whitespace 검사를 통과했다. 전체 로그는 보존하고 부모에게 payload가 노출되지 않도록 aggregate gate 결과만 표시했다. 이전 성공 횟수는 이월하지 않으며 일곱 사례·세 회차의 무수정 검증 기준을 유지한다.

`7f390a9b5b2fbf702302d19e0dbb908b70680640`의 26개 파일을 동결하여 세 회차를 마쳤다. Product source는 C20과 같다. 사용자 확인 동안 19건 뒤 안전 경계에서 잠시 멈췄고, 재개 지시에 따라 나머지 두 건만 실행했다. 기존 결과를 재실행·덮어쓰기하거나 deadline을 연장하지 않았다.

| 사례 | 1회 | 2회 | 3회 |
|---|---|---|---|
| research-local | 통과 12/12 · 6523 | 통과 12/12 · 12060 | 통과 12/12 · 15562 |
| interview-correction | 실패 11/13 · 179440 | 통과 13/13 · 144991 | 통과 13/13 · 126824 |
| plan-software | 실패 10/13 · 1185200 | 실패 9/13 · 602543 | 실패 12/13 · 899122 |
| execute-summary | 실패 12/17 · 993654 | 실패 16/17 · 669067 | 실패 15/17 · 988195 |
| inventory (개발) | 실패 12/17 · 346162 | 실패 12/17 · 991140 | 실패 11/17 · 434956 |
| execute-fresh-021a-heldout | 차단 12/17 · 341276 | 실패 11/17 · 1200292 | 실패 11/17 · 710909 |
| execute-fresh-021b-heldout | 실패 11/17 · 935379 | 실패 11/17 · 933759 | 실패 11/17 · 911953 |

단위는 ms다. 최종 결과 21건은 **통과 5, 실패 15, 차단 1**, clean 회차는 **0**이다. 모두 complete native coverage, dispatch 거절·result 무효화 0건이지만 이것은 fixture 위반·control-body 오류·role timeout 부재를 뜻하지 않는다. Summary 2회차는 실제 승인과 독립 완료 검사를 통과했으나 role interruption 때문에 전체 실패다. 두 heldout은 소비됐으며 후속 tuning의 fresh 검증에 재사용하지 않는다.

개발 사례 감사에서는 planning 1회차의 timeout 네 건이 모두 Approach Reviewer였고, 완료된 네 응답 중 host schema/semantic 거절은 없었음을 확인했다. Review가 요구한 revision과 SDK repair는 구분한다. Interview 1회차는 충돌을 처음 인식했지만 open material-gap coverage 오류를 고치는 동안 typed contradiction을 제거했다. 충돌 의미와 not-ready 상태는 유지됐어도 기존 typed-state assertion은 실패로 남는다. 뒤이은 workspace-root read도 fixture 위반이며 native 거절은 아니었다.

이 개발 감사의 범위 제한 read가 도구 문제로 인접 fresh 정의까지 반환한 사고도 보존했다. 해당 reviewer는 더 이상 fresh-blind가 아니며 내용은 부모에게 재전송하거나 tuning에 사용하지 않았다. Matrix 도중 product/protocol 변경은 없었지만 완벽한 lane 격리를 주장하지 않는다.

### C22: 남은 native 문자열 제약과 interview 표현 보정

C21 개발 revision의 resolution explanation이 한 글자였고, native schema의 해당 필드에 C5에서 문제를 재현했던 `pattern: "\\S"`가 남아 있었다. Matrix 종료 후 정확한 동결 필드 schema를 복제한 tool-free Pi/Solar Pro4 Max 요청에서 동일 문장을 두 필드에 요구했다. Pattern 쪽은 `"2"`, pattern만 제거한 쪽은 요청한 전체 문장을 반환했다(2035 ms). 이는 해당 제약의 출력 축소 재현이며 별도 reviewer timeout의 원인이나 전체 계획 품질 개선을 증명하지 않는다.

그 native pattern만 제거했다. String type, 1–4000 길이, finding ID 결속과 host의 공백·의미 검사는 유지한다. 새 회귀를 동결 C21의 별도 mirror에 적용하면 pattern 존재 assertion이 실패했고, 수정본에서는 공백 explanation 거절과 유효 explanation의 원문 보존까지 통과했다.

Interview는 validator를 바꾸지 않았다. 이미 허용되는 별개의 material-gap/contradiction ID를 함께 저장·복구할 수 있고, gap coverage 누락과 unresolved 상태의 ready 선언은 계속 거절됨을 검증했다. 이에 맞춰 기존 ledger gap을 readiness에 포함하면서 typed contradiction도 남기라는 preflight 설명만 추가했다. 실제 모델의 repair 중 분류 손실이 줄어드는지는 별도 개발 가설이다.

부모 검증은 **323/323**, installed-Pi의 기존 17개 assertion과 거절/일반 오류 시나리오, 37-file package/private 제외 및 whitespace 통과다. C21 결과는 유지하며 새 source/protocol의 성공 횟수는 다시 시작한다. 두 개발 과제의 세 쌍 비교는 종합 13/13을 주 지표로 사전등록했고, schema 진단이나 중간 상태만으로 성공을 대신하지 않는다.

C22는 `cd1bc746d24f419275b5819dd3c8084a68c4bd85`와 일치하게 동결했다. Source는 `211a8f0a6225117001c9dc9e6036957171665252e7fc0d2968f3eef5320b382a`, protocol은 `462f4cb8aab8885e1f3fc30e4c8e01dcbe9053dafdb67805fc24870705f7fdd3`이다. Trusted schema 소스가 protocol hash에 포함되므로 두 군의 hash는 다르지만 driver·fixture·grader predicate는 byte-identical이다.

| 과제/쌍 | C21 | C22 |
|---|---|---|
| interview / 1 | 통과 13/13 · 391907 | 실패 12/13 · 219609 |
| interview / 2 | 실패 12/13 · 324395 | 실패 12/13 · 144328 |
| interview / 3 | 통과 13/13 · 182309 | 실패 12/13 · 311096 |
| plan / 1 | 실패 12/13 · 999647 | 실패 11/13 · 786982 |
| plan / 2 | 실패 10/13 · 983682 | 실패 9/13 · 700060 |
| plan / 3 | 실패 10/13 · 1200189 | 실패 10/13 · 1200095 |

단위는 ms다. Interview의 typed contradiction 저장은 양쪽 3/3이지만 종합 통과는 **2/3 대 0/3**이다. 네 interview 실패는 모두 fixture 정책 위반이었다. Planning 종합 통과는 양쪽 **0/3**이며 마지막 쌍은 전체 runner 제한에 도달했다. 12건 모두 complete native coverage 및 거절·무효화 0건이지만 해당 범위 밖 실패는 그대로 남는다. Native 문자열 결함 보정은 검증됐어도 timeout 해결·전체 품질 개선·clarification의 인과적 효과는 입증되지 않았다. 중간 tuning은 없었고 모든 실패를 유지했다.

별도 C22 breadth에서는 research **12/12 · 7993 ms** 통과, inventory **11/17 · 959068 ms** 실패, summary **15/17 · 988684 ms** 실패였다. Summary는 독립 완료 검사까지 통과했지만 role interruption과 현재 step에 선언되지 않은 `read(summary.json)`의 실제 native 거절 한 건이 남았다.

실행 인자 선택을 돕는 enum-only 제안도 별도 isolated Pi/Solar Max probe로 확인했다. 절대 경로를 명시적으로 요구한 동일 조건에서 기본 schema와 상대 경로 enum을 추가한 variant 모두 절대 경로를 호출했고, 같은 진단 guard가 둘 다 거절했다. 한 adversarial 조건의 관측이며 일반적인 무효성을 증명하지 않지만, 개선 근거도 없으므로 production projection은 추가하지 않았다. Global Pi settings는 바뀌지 않았다. 첫 inline supervisor의 shell-quoting 구문 실패는 Pi 호출 전 발생한 setup 실패로 별도 보존했다.

### C23: 수정 없는 연속 검증

C22 tuning 이후 새 opaque heldout 두 건을 별도로 작성했다. 독립 reviewer의 정적 oracle/경계/난도 검토는 CLEAR이고, 중단된 첫 review는 원인을 추정하지 않은 채 기존 context로 재개했다. 부모는 payload를 표시하지 않고 hash, 다섯 개발 fixture와 generic predicate의 동일성을 확인했다. **323/323**, installed-Pi 17개 assertion과 기존 negative 시나리오, 37-file package/private 제외 및 whitespace 검사가 통과했다.

이 protocol은 동일한 일곱 사례를 순서대로 반복하며 최소 세 회차를 관측한다. 세 회차 연속으로 모든 assertion과 fixture/native 안전 검사가 통과하면 후보 종료 자격만 기록하고 별도로 결함·deliverable을 확인한다. 그렇지 않으면 같은 동결 source/protocol로 원래 deadline까지 이어가며 실패를 지우거나 성공한 사례만 골라 반복하지 않는다. Source/protocol tuning이 필요해지면 안전 경계에서 멈추고 새 검증으로 구분한다. API 접근량과 무관하게 role·case·SDK·repair 제한과 원래 168시간 종료 시각은 유지한다.
