<?php
/**
 * Drift check for prepush.sh: wp eval-file drift.php <file> [<post-type>]
 *
 * Resolves the file and its slug/type with the plugin's own parser, as `wp pac push` does,
 * then prints one tab-separated line:
 *   new                      no post with that slug yet
 *   clean                    pushed by pac and not edited since
 *   drift   <id> <slug> <rev> <last>  a revision newer than the last push: edited in wp-admin
 *   foreign <id> <slug>               the post exists but pac never pushed it
 *   error  <message>         push itself will report it
 */
$pac_rel  = $args[0] ?? '';
$pac_flag = $args[1] ?? '';

if ( ! class_exists( 'PAC_File' ) ) {
	echo "error\tpages-as-code is not active\n";
	return;
}
$pac_file = PAC_File::parse( $pac_rel );
if ( is_wp_error( $pac_file ) ) {
	echo "error\t" . $pac_file->get_error_message() . "\n";
	return;
}
$pac_type = pac_resolve_post_type( $pac_file, '' !== $pac_flag ? $pac_flag : null );
if ( is_wp_error( $pac_type ) ) {
	echo "error\t" . $pac_type->get_error_message() . "\n";
	return;
}

$pac_q = get_posts(
	array(
		'post_type'      => $pac_type,
		'name'           => $pac_file->slug,
		'post_status'    => array( 'publish', 'draft', 'pending', 'private', 'future' ),
		'posts_per_page' => 1,
	)
);
if ( ! $pac_q ) {
	echo "new\n";
	return;
}
$pac_post = $pac_q[0];
$pac_last = get_post_meta( $pac_post->ID, '_pac_last_push_gmt', true );
if ( ! $pac_last ) {
	echo "foreign\t{$pac_post->ID}\t{$pac_post->post_name}\n";
	return;
}
// Newest saved revision (autosaves are unsaved editor drafts), else the post itself.
// A push's own revision is not newer than its meta.
$pac_rts = $pac_post->post_modified_gmt;
foreach ( wp_get_post_revisions( $pac_post->ID, array( 'orderby' => 'ID', 'order' => 'DESC' ) ) as $pac_rev ) {
	if ( ! wp_is_post_autosave( $pac_rev ) ) {
		$pac_rts = $pac_rev->post_modified_gmt;
		break;
	}
}
if ( strtotime( $pac_rts . ' UTC' ) > strtotime( $pac_last ) ) {
	echo "drift\t{$pac_post->ID}\t{$pac_post->post_name}\t{$pac_rts}\t{$pac_last}\n";
	return;
}
echo "clean\n";
