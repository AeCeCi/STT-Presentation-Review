import 'package:flutter_test/flutter_test.dart';
import 'package:stt_project/main.dart';

void main() {
  testWidgets('renders the presentation review home screen', (tester) async {
    await tester.pumpWidget(const PresentationReviewApp());

    expect(find.text('발표 코치'), findsOneWidget);
    expect(find.text('음성 및 발표자료'), findsOneWidget);
    expect(find.text('등록\n발표자료'), findsOneWidget);

    await tester.tap(find.text('발표\n연습'));
    await tester.pumpAndSettle();
    expect(find.text('발표 연습'), findsOneWidget);

    await tester.tap(find.text('예상질문\n준비'));
    await tester.pumpAndSettle();
    expect(find.text('예상질문 준비'), findsOneWidget);

    await tester.tap(find.text('분석\n결과'));
    await tester.pumpAndSettle();
    expect(find.text('분석 결과'), findsOneWidget);

    await tester.tap(find.text('종합\n결과'));
    await tester.pumpAndSettle();
    expect(find.text('종합 결과'), findsOneWidget);
  });
}
