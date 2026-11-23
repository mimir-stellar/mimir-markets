use crate::test_common::{Fixture, USDC};

#[test]
fn creator_claims_indexing_and_pagination() {
    let f = Fixture::new(0, 0);
    let creator = f.user(100 * USDC);

    let id1 = f.client().create_claim(&creator, &f.params(2 * USDC));
    let id2 = f.client().create_claim(&creator, &f.params(3 * USDC));
    let id3 = f.client().create_claim(&creator, &f.params(4 * USDC));

    let (page, total) = f.client().get_creator_claims(&creator, &0, &2);
    assert_eq!(total, 3);
    assert_eq!(page.len(), 2);
    assert_eq!(page.get(0).unwrap(), id1);
    assert_eq!(page.get(1).unwrap(), id2);

    let (page2, total2) = f.client().get_creator_claims(&creator, &2, &2);
    assert_eq!(total2, 3);
    assert_eq!(page2.len(), 1);
    assert_eq!(page2.get(0).unwrap(), id3);

    let (page_all, total_all) = f.client().get_creator_claims(&creator, &0, &0);
    assert_eq!(total_all, 3);
    assert_eq!(page_all.len(), 3);
}
