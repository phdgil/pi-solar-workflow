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

총 20개 runner 실행에서 main 응답기록 131개와 Planner SDK attempt 11개가 관측되었다. 과제별로 research 8회, development execution 4회, planning-only 2회, inventory held-out 6회다. 이 합계 밖의 연결/transport 진단은 품질 비교 분모에 넣지 않았다. `interview-correction`은 별도 실제-model case로 실행하지 못했고, 실제 흐름이 리뷰/실행까지 완료되지 않아 Approach Reviewer, Critic, Executor의 live task 품질도 입증하지 못했다.

## 최종 source 회귀 검증

- `npm test`: **236 tests 통과**, 실패/skip 없음.
- `npm run test:pi`: 설치된 Pi 0.85.1의 loopback 통합 검사 통과. 전체 agent/skill prompt 전송, 단계 전환, planning dispatcher의 read 부재, 격리된 세 planning role의 도구 부재, exact goal confirmation, host-owned research, planning-only 종료를 검사했다.
- `git diff --check`: 통과.
- `npm pack --dry-run --ignore-scripts --json`: 36개 배포 파일에서 loader/registry/6개 전용 skill/설계·실측 문서 포함을 확인했다. 원문 실험·credential 파일은 제외되었다. 실제 npm publish나 전역 설치는 하지 않았다.

이 검증은 post-holdout 통합 수정의 source/SDK 동작 증거다. 실제 Solar의 성공한 full-loop 결과를 대신하지 않는다.
